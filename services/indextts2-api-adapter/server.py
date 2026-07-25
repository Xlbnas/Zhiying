"""Zhiying IndexTTS2 API Adapter（M3-F）。

知影生产 TTS 架构：

    Zhiying Node Worker (src/lib/tts/indextts2.ts, frozen)
      → HTTP  → 本 Adapter（HTTP translation/control plane，无 GPU/无 torch）
      → HTTP  → 现有 IndexTTS2 REST API（neosun 容器, 127.0.0.1:8002, GPU 常驻）

对 Zhiying 暴露 frozen contract：
    GET  /health
    POST /v1/synthesize  → audio/wav bytes

设计约束（M3-F spec）：
- 极薄：不 import torch、不加载模型、不占 GPU（真实 GPU 只由 8002 进程使用）
- useRandom=false 语义 = 不启用 emotion random sampling；不声称 byte deterministic
- speaker identity：reference file + speaker_name 为 source of truth，
  不硬编码 spk_xxx（speaker cache 可被清除后重建）
- per voice single-flight registration（进程内 lock，防重复 upload）
"""

from __future__ import annotations

import asyncio
import os
from typing import Dict, Optional, Tuple

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ---------- 配置（全部环境变量，无任何 secret）----------

UPSTREAM_BASE_URL = os.environ.get("ADAPTER_UPSTREAM_BASE_URL", "http://127.0.0.1:18002").rstrip("/")
UPSTREAM_TIMEOUT_SEC = float(os.environ.get("ADAPTER_UPSTREAM_TIMEOUT_SEC", "90"))
HEALTH_TIMEOUT_SEC = float(os.environ.get("ADAPTER_HEALTH_TIMEOUT_SEC", "10"))
# reference voice 本地 runtime 路径（speaker cache 缺失时用于 upload；不入 Git）
REFERENCE_VOICE_PATH = os.environ.get("ADAPTER_REFERENCE_VOICE_PATH", "")

# voiceProfile/voiceRevision → speaker 映射（最小 deterministic whitelist，
# 后续生产 voice profile 体系单独设计；未知 profile/revision 一律 4xx）。
# 注意：frozen M3-B 的 DEFAULT_VOICE_PROFILE 为 default@1——revision '1'
# 即当前参考音频（m3f-test-reference）的第一版；换参考音频时应新增 revision。
VOICE_MAP: Dict[str, Dict[str, Dict[str, str]]] = {
    "default": {
        "1": {
            "speakerName": "zhiying-m3f-test",
            "referencePath": REFERENCE_VOICE_PATH,
        },
    },
}

MODEL_NAME = "IndexTTS-2"
# upstreamApiVersion / deploymentImage 记录在 README/log，绝不填进 repoCommit
UPSTREAM_API_VERSION = "2.2.0"

app = FastAPI(title="Zhiying IndexTTS2 API Adapter", version="1.0.0")

_client: Optional[httpx.AsyncClient] = None
_speaker_ids: Dict[str, str] = {}  # voiceKey -> upstream speaker_id（内存 cache）
_voice_locks: Dict[str, asyncio.Lock] = {}


def _client_or_create() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=UPSTREAM_BASE_URL,
            timeout=httpx.Timeout(UPSTREAM_TIMEOUT_SEC),
        )
    return _client


@app.on_event("shutdown")
async def _shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _voice_lock(key: str) -> asyncio.Lock:
    if key not in _voice_locks:
        _voice_locks[key] = asyncio.Lock()
    return _voice_locks[key]


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "message": message})


# ---------- /health ----------


@app.get("/health")
async def health() -> Response:
    """ready 需要 upstream 可达（GET /speakers 轻量探测）；进程存活但 upstream
    不可达时 ready=false（Adapter 自身仍 200 返回 JSON）。"""
    ready = False
    try:
        client = _client_or_create()
        res = await client.get("/speakers", timeout=HEALTH_TIMEOUT_SEC)
        ready = res.status_code == 200
    except Exception:
        ready = False
    # repoCommit：无法取得真实 upstream Git commit——省略，绝不伪造
    return JSONResponse(
        {
            "ready": ready,
            "provider": "indextts2",
            "model": MODEL_NAME,
            "fp16": None,
        }
    )


# ---------- /v1/synthesize ----------


class SynthesizeRequest(BaseModel):
    text: str
    voiceProfile: str
    voiceRevision: Optional[str] = None
    useRandom: bool = False
    emotion: str = "none"


async def _find_speaker_id(client: httpx.AsyncClient, speaker_name: str) -> Optional[str]:
    res = await client.get("/speakers")
    if res.status_code != 200:
        raise RuntimeError(f"upstream /speakers HTTP {res.status_code}")
    data = res.json()
    for spk in data.get("speakers", []):
        if spk.get("speaker_name") == speaker_name:
            return spk.get("speaker_id")
    return None


async def _resolve_speaker_id(voice_key: str, speaker_name: str, reference_path: str) -> Tuple[Optional[str], Optional[JSONResponse]]:
    """single-flight：同一 voice 并发请求只注册一次。"""
    async with _voice_lock(voice_key):
        if voice_key in _speaker_ids:
            return _speaker_ids[voice_key], None
        client = _client_or_create()
        try:
            speaker_id = await _find_speaker_id(client, speaker_name)
        except Exception as exc:
            return None, _err(503, "UPSTREAM_UNAVAILABLE", f"upstream /speakers 不可达：{exc}")
        if speaker_id is None:
            if not reference_path or not os.path.isfile(reference_path):
                return None, _err(
                    503,
                    "REFERENCE_VOICE_MISSING",
                    f"speaker {speaker_name} 未注册且 reference 文件不存在: {reference_path or '(未配置)'}",
                )
            try:
                with open(reference_path, "rb") as fh:
                    res = await client.post(
                        "/upload_speaker",
                        data={"speaker_name": speaker_name},
                        files={"audio": (os.path.basename(reference_path), fh.read(), "audio/wav")},
                    )
            except Exception as exc:
                return None, _err(503, "UPSTREAM_UNAVAILABLE", f"upstream /upload_speaker 不可达：{exc}")
            if res.status_code != 200:
                return None, _err(
                    502,
                    "UPSTREAM_HTTP_ERROR",
                    f"upstream /upload_speaker HTTP {res.status_code}: {res.text[:300]}",
                )
            speaker_id = res.json().get("speaker_id")
            if not speaker_id:
                return None, _err(502, "UPSTREAM_INVALID_RESPONSE", "upstream /upload_speaker 未返回 speaker_id")
        _speaker_ids[voice_key] = speaker_id
        return speaker_id, None


@app.post("/v1/synthesize")
async def synthesize(req: SynthesizeRequest) -> Response:
    # ---- 严格输入验证（不 silent ignore）----
    if not req.text or not req.text.strip():
        return _err(422, "INVALID_REQUEST", "text 必须非空")
    profile = VOICE_MAP.get(req.voiceProfile)
    if profile is None:
        return _err(404, "VOICE_PROFILE_NOT_FOUND", f"未知 voiceProfile: {req.voiceProfile!r}")
    revision = req.voiceRevision or ""
    voice = profile.get(revision)
    if voice is None:
        return _err(404, "VOICE_REVISION_NOT_FOUND", f"未知 voiceRevision: {revision!r}")
    if req.useRandom is not False:
        return _err(422, "UNSUPPORTED_USE_RANDOM", "本部署仅支持 useRandom=false（不启用 emotion random sampling）")
    if req.emotion != "none":
        return _err(422, "UNSUPPORTED_EMOTION", "本部署仅支持 emotion='none'（speaker-reference/default emotion）")

    voice_key = f"{req.voiceProfile}@{revision}"
    speaker_id, err = await _resolve_speaker_id(voice_key, voice["speakerName"], voice["referencePath"])
    if err is not None:
        return err

    # ---- upstream synthesis（不传 emo_vector/emo_alpha/emotion random/text）----
    client = _client_or_create()
    try:
        res = await client.post(
            "/tts_cached",
            json={"text": req.text, "speaker_id": speaker_id},
        )
    except httpx.TimeoutException:
        return _err(504, "UPSTREAM_TIMEOUT", f"upstream /tts_cached 超时（{UPSTREAM_TIMEOUT_SEC}s）")
    except Exception as exc:
        return _err(503, "UPSTREAM_UNAVAILABLE", f"upstream /tts_cached 不可达：{exc}")
    if res.status_code != 200:
        return _err(
            502,
            "UPSTREAM_HTTP_ERROR",
            f"upstream /tts_cached HTTP {res.status_code}: {res.text[:300]}",
        )
    body = res.content
    if len(body) < 44 or body[:4] != b"RIFF":
        return _err(502, "UPSTREAM_INVALID_RESPONSE", "upstream 返回内容不是合法 WAV")
    return Response(content=body, media_type="audio/wav")
