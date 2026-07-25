"""Zhiying IndexTTS2 API Adapter（M4-B production registry 版）。

知影生产 TTS 架构：

    Zhiying Node Worker (src/lib/tts/indextts2.ts, frozen)
      → HTTP  → 本 Adapter（HTTP translation/control plane，无 GPU/无 torch）
      → HTTP  → 现有 IndexTTS2 REST API（neosun 容器, GPU 常驻）

对 Zhiying 暴露 frozen contract：
    GET  /health
    POST /v1/synthesize  → audio/wav bytes

设计约束：
- 极薄：不 import torch、不加载模型、不占 GPU（真实 GPU 只由 upstream 进程使用）
- useRandom=false 语义 = 不启用 emotion random sampling；不声称 byte deterministic
- voice identity（M4-A frozen）：
    SHA-256     = Zhiying immutable reference identity（production source of truth）
    MD5         = upstream speaker cache compatibility identifier（非密码学 SoT）
    speakerName = readable deterministic label（不作内容证明）
    speaker_id  = runtime upstream cache handle（不进入 Zhiying contract）
- production voice 一律来自 registry 文件（ADAPTER_VOICE_REGISTRY_PATH），
  无任何硬编码 fallback；registry 未配置/非法 → ready=false + synthesize 503
- per voice single-flight registration（进程内 lock，防重复 upload）
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from typing import Dict, Optional, Tuple

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ---------- 配置（全部环境变量，无任何 secret）----------

UPSTREAM_BASE_URL = os.environ.get("ADAPTER_UPSTREAM_BASE_URL", "http://127.0.0.1:18002").rstrip("/")
UPSTREAM_TIMEOUT_SEC = float(os.environ.get("ADAPTER_UPSTREAM_TIMEOUT_SEC", "90"))
HEALTH_TIMEOUT_SEC = float(os.environ.get("ADAPTER_HEALTH_TIMEOUT_SEC", "10"))
# production voice registry（JSON，可版本控制、无音频内容）
VOICE_REGISTRY_PATH = os.environ.get("ADAPTER_VOICE_REGISTRY_PATH", "")
# reference WAV 允许根目录（containment 边界）
VOICE_ROOT = os.environ.get("ADAPTER_VOICE_ROOT", "/voices")

SUPPORTED_SCHEMA_VERSION = "1.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

MODEL_NAME = "IndexTTS-2"
# upstreamApiVersion / deploymentImage 记录在 README/log，绝不填进 repoCommit
UPSTREAM_API_VERSION = "2.2.0"

app = FastAPI(title="Zhiying IndexTTS2 API Adapter", version="1.1.0")

_client: Optional[httpx.AsyncClient] = None
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


# ---------- Production Voice Registry ----------


class VoiceEntry:
    """单个 production voice（registry 声明 + runtime 文件校验缓存）。"""

    __slots__ = (
        "profile",
        "revision",
        "speaker_name",
        "reference_path",  # realpath 后、已 containment 校验
        "reference_sha256",  # registry 声明（source of truth）
        "expected_md5",  # upstream cache compatibility identifier
        "_sig",  # (mtime_ns, size) — hash 缓存失效依据
        "_actual_sha256",
    )

    def __init__(self, profile: str, revision: str, speaker_name: str,
                 reference_path: str, reference_sha256: str) -> None:
        self.profile = profile
        self.revision = revision
        self.speaker_name = speaker_name
        self.reference_path = reference_path
        self.reference_sha256 = reference_sha256
        self.expected_md5 = ""
        self._sig: Optional[Tuple[int, int]] = None
        self._actual_sha256 = ""


class RegistryState:
    __slots__ = ("status", "voices")

    def __init__(self, status: str, voices: Optional[Dict[str, VoiceEntry]] = None) -> None:
        # status: "OK" 或 VOICE_REGISTRY_* 错误码
        self.status = status
        self.voices = voices or {}


def _load_registry() -> RegistryState:
    """启动时加载并严格验证 registry。任何非法 → 非 OK（ready=false，不 crash，
    以便 Docker healthcheck 表达 unready 而不是进程退出）。"""
    if not VOICE_REGISTRY_PATH:
        return RegistryState("VOICE_REGISTRY_NOT_CONFIGURED")
    try:
        with open(VOICE_REGISTRY_PATH, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return RegistryState("VOICE_REGISTRY_UNREADABLE")
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return RegistryState("VOICE_REGISTRY_INVALID")
    if not isinstance(data, dict) or data.get("schemaVersion") != SUPPORTED_SCHEMA_VERSION:
        return RegistryState("VOICE_REGISTRY_UNSUPPORTED_SCHEMA")
    voices = data.get("voices")
    if not isinstance(voices, list) or len(voices) == 0:
        return RegistryState("VOICE_REGISTRY_INVALID")

    root_real = os.path.realpath(VOICE_ROOT)
    result: Dict[str, VoiceEntry] = {}
    for item in voices:
        if not isinstance(item, dict):
            return RegistryState("VOICE_REGISTRY_INVALID")
        profile = item.get("voiceProfile")
        revision = item.get("voiceRevision")
        speaker_name = item.get("speakerName")
        ref_path = item.get("referenceAssetPath")
        ref_sha = item.get("referenceSha256")
        if not (isinstance(profile, str) and profile.strip()):
            return RegistryState("VOICE_REGISTRY_INVALID")
        if not (isinstance(revision, str) and revision.strip()):
            return RegistryState("VOICE_REGISTRY_INVALID")
        if not (isinstance(speaker_name, str) and speaker_name.strip()):
            return RegistryState("VOICE_REGISTRY_INVALID")
        if not (isinstance(ref_path, str) and os.path.isabs(ref_path)):
            # 相对路径与 ../ 逃逸一并拒绝（realpath 后 containment 再兜底）
            return RegistryState("VOICE_REGISTRY_INVALID")
        if not (isinstance(ref_sha, str) and SHA256_RE.match(ref_sha)):
            return RegistryState("VOICE_REGISTRY_INVALID")
        key = f"{profile}@{revision}"
        if key in result:
            return RegistryState("VOICE_REGISTRY_INVALID")
        # realpath 解析 symlink 后做 containment——symlink 逃逸在此被拒绝
        real = os.path.realpath(ref_path)
        if real != root_real and os.path.commonpath([root_real, real]) != root_real:
            return RegistryState("VOICE_REGISTRY_INVALID")
        result[key] = VoiceEntry(profile, revision, speaker_name, real, ref_sha)
    return RegistryState("OK", result)


REGISTRY = _load_registry()


def _check_voice(voice: VoiceEntry) -> str:
    """文件存在性 + SHA-256 校验（带 mtime+size 缓存）。返回 "" 表示可用，
    否则返回 detail 错误码。绝不静默接受变更文件。"""
    try:
        st = os.stat(voice.reference_path)
    except OSError:
        return "REFERENCE_VOICE_MISSING"
    if not os.path.isfile(voice.reference_path):
        return "REFERENCE_VOICE_MISSING"
    sig = (st.st_mtime_ns, st.st_size)
    if sig != voice._sig:
        sha = hashlib.sha256()
        md5 = hashlib.md5()  # noqa: S324 — upstream cache compatibility，非密码学用途
        with open(voice.reference_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                sha.update(chunk)
                md5.update(chunk)
        voice._sig = sig
        voice._actual_sha256 = sha.hexdigest()
        voice.expected_md5 = md5.hexdigest()
    if voice._actual_sha256 != voice.reference_sha256:
        return "REFERENCE_SHA256_MISMATCH"
    return ""


# ---------- /health ----------


@app.get("/health")
async def health() -> Response:
    """ready=true 当且仅当：upstream 可达 AND registry 有效 AND 每个 voice 的
    reference 文件存在且 SHA-256 与 registry 一致。进程存活但任一条件不满足
    时 ready=false（Adapter 自身仍 200 返回 JSON）。"""
    upstream_ok = False
    try:
        client = _client_or_create()
        res = await client.get("/speakers", timeout=HEALTH_TIMEOUT_SEC)
        upstream_ok = res.status_code == 200
    except Exception:
        upstream_ok = False

    detail = ""
    if REGISTRY.status != "OK":
        detail = REGISTRY.status
    else:
        for voice in REGISTRY.voices.values():
            detail = _check_voice(voice)
            if detail:
                break
    ready = upstream_ok and not detail
    # fp16 / repoCommit：均无法取得真实值——字段直接省略，绝不返回 null 占位、绝不伪造
    body: Dict[str, object] = {
        "ready": ready,
        "provider": "indextts2",
        "model": MODEL_NAME,
    }
    if not ready:
        body["detail"] = detail or "UPSTREAM_UNAVAILABLE"
    return JSONResponse(body)


# ---------- /v1/synthesize ----------


class SynthesizeRequest(BaseModel):
    text: str
    voiceProfile: str
    voiceRevision: Optional[str] = None
    useRandom: bool = False
    emotion: str = "none"


async def _resolve_speaker_id(voice_key: str, voice: VoiceEntry) -> Tuple[Optional[str], Optional[JSONResponse]]:
    """per-voice single-flight 内的权威解析。
    speaker_id 只是 upstream runtime handle：upstream speaker cache 可能被清理/
    重建，进程内缓存会在此时变成 stale——因此**不做未经验证的跨请求缓存**，
    每次 synthesize 都按内容 MD5 重新解析（Zhiying 单 Worker 全局 FIFO，
    一次轻量 /speakers 代价可接受）。绝不按 speaker_name 作为首要 identity。"""
    async with _voice_lock(voice_key):
        client = _client_or_create()
        try:
            res = await client.get("/speakers")
        except Exception as exc:
            return None, _err(503, "UPSTREAM_UNAVAILABLE", f"upstream /speakers 不可达：{exc}")
        if res.status_code != 200:
            return None, _err(502, "UPSTREAM_HTTP_ERROR", f"upstream /speakers HTTP {res.status_code}")
        speaker_id: Optional[str] = None
        for spk in res.json().get("speakers", []):
            # 按内容 MD5 查找，绝不按 speaker_name 作为首要 identity
            if spk.get("md5") == voice.expected_md5:
                speaker_id = spk.get("speaker_id")
                if spk.get("speaker_name") != voice.speaker_name:
                    # Case A：同内容不同名——可 reuse，记录 provenance 警告
                    print(
                        f"[adapter] WARN: MD5 命中但 speaker_name 不同 "
                        f"(upstream={spk.get('speaker_name')!r}, registry={voice.speaker_name!r})，按内容 reuse"
                    )
                break
        if speaker_id is None:
            try:
                with open(voice.reference_path, "rb") as fh:
                    res = await client.post(
                        "/upload_speaker",
                        data={"speaker_name": voice.speaker_name},
                        files={"audio": (os.path.basename(voice.reference_path), fh.read(), "audio/wav")},
                    )
            except Exception as exc:
                return None, _err(503, "UPSTREAM_UNAVAILABLE", f"upstream /upload_speaker 不可达：{exc}")
            if res.status_code != 200:
                return None, _err(
                    502,
                    "UPSTREAM_HTTP_ERROR",
                    f"upstream /upload_speaker HTTP {res.status_code}: {res.text[:300]}",
                )
            payload = res.json()
            # fail-closed：upstream 确认的内容 MD5 必须与本地 reference 一致
            if payload.get("md5") != voice.expected_md5:
                return None, _err(
                    502,
                    "UPSTREAM_CACHE_CONFLICT",
                    "upstream /upload_speaker 返回 MD5 与 reference 不一致（拒绝使用，未覆盖任何既有 speaker）",
                )
            speaker_id = payload.get("speaker_id")
            if not speaker_id:
                return None, _err(502, "UPSTREAM_INVALID_RESPONSE", "upstream /upload_speaker 未返回 speaker_id")
        return speaker_id, None


@app.post("/v1/synthesize")
async def synthesize(req: SynthesizeRequest) -> Response:
    # ---- 严格输入验证（不 silent ignore）----
    if not req.text or not req.text.strip():
        return _err(422, "INVALID_REQUEST", "text 必须非空")
    if REGISTRY.status != "OK":
        return _err(503, "VOICE_REGISTRY_INVALID", f"voice registry 不可用（{REGISTRY.status}）")
    revision = req.voiceRevision or ""
    voice = REGISTRY.voices.get(f"{req.voiceProfile}@{revision}")
    if voice is None:
        if any(v.profile == req.voiceProfile for v in REGISTRY.voices.values()):
            return _err(404, "VOICE_REVISION_NOT_FOUND", f"未知 voiceRevision: {revision!r}")
        return _err(404, "VOICE_PROFILE_NOT_FOUND", f"未知 voiceProfile: {req.voiceProfile!r}")
    if req.useRandom is not False:
        return _err(422, "UNSUPPORTED_USE_RANDOM", "本部署仅支持 useRandom=false（不启用 emotion random sampling）")
    if req.emotion != "none":
        return _err(422, "UNSUPPORTED_EMOTION", "本部署仅支持 emotion='none'（speaker-reference/default emotion）")

    # ---- reference 文件存在性 + SHA-256（fail-closed）----
    voice_bad = _check_voice(voice)
    if voice_bad == "REFERENCE_VOICE_MISSING":
        return _err(503, "REFERENCE_VOICE_MISSING", f"reference 文件不存在（{req.voiceProfile}@{revision}）")
    if voice_bad:
        return _err(503, "REFERENCE_SHA256_MISMATCH", f"reference SHA-256 与 registry 不一致（{req.voiceProfile}@{revision}）")

    voice_key = f"{req.voiceProfile}@{revision}"
    speaker_id, err = await _resolve_speaker_id(voice_key, voice)
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
