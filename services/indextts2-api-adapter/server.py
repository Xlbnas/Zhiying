"""Zhiying IndexTTS2 API Adapter（M4-B production registry 版）。

知影生产 TTS 架构：

    Zhiying Node Worker (src/lib/tts/indextts2.ts, frozen)
      → HTTP  → 本 Adapter（HTTP translation/control plane，无 GPU/无 torch）
      → HTTP  → 现有 IndexTTS2 REST API（neosun 容器, GPU 常驻）

对 Zhiying 暴露 frozen contract：
    GET  /health
    POST /v1/synthesize  → audio/wav bytes

TTS-C.1B.1 registry publication contract（向后兼容，publisher 未实现）：
    GET  /registry-status  → 唯一 activation acknowledgment 观察面
    POST /reload           → 重新读取配置的固定 registry 路径，验证后一次性原子替换
registry schema 双支持："1.0"（legacy，production 现状，无 generation/publisher
字段）与 "1.1"（publisher 输出，必须携带 registryGeneration positive integer +
publisherSchemaVersion 精确值）。绝不自动改写 registry 文件。
reload/启动加载在给出任何 OK/ack 前，对每个 voice 的 reference 文件做完整验证
（存在 + 普通文件 + 可读 + 实际 SHA-256 == referenceSha256）；任一失败 → 本次加载
非 OK。reload 失败：有 LKG → 保持旧 state/旧 voices + degraded=true + lastReloadError
（旧 voice 继续 synthesize）；无 LKG → ready=false + synthesize 503。

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
import threading
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

# registry schema 双支持（TTS-C.1B.1）：
#   "1.0" legacy（production 现状；无 generation/publisher 字段 → 内部状态 None）
#   "1.1" publisher（未来 publisher 输出；必须携带 registryGeneration positive
#         integer + publisherSchemaVersion 精确值）
LEGACY_REGISTRY_SCHEMA_VERSION = "1.0"
PUBLISHER_REGISTRY_SCHEMA_VERSION = "1.1"
SUPPORTED_REGISTRY_SCHEMA_VERSIONS = (LEGACY_REGISTRY_SCHEMA_VERSION, PUBLISHER_REGISTRY_SCHEMA_VERSION)
# 1.1 唯一支持的 publisherSchemaVersion 值
SUPPORTED_PUBLISHER_SCHEMA_VERSION = "tts-c-registry-publisher@1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

MODEL_NAME = "IndexTTS-2"
# upstreamApiVersion / deploymentImage 记录在 README/log，绝不填进 repoCommit
UPSTREAM_API_VERSION = "2.2.0"

app = FastAPI(title="Zhiying IndexTTS2 API Adapter", version="1.2.0")

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
    """当前生效 registry 的完整状态（TTS-C.1B.1）。

    任何变更 = 整体不可变替换（单引用赋值 + threading.Lock）；reader 只持有一次
    快照引用，绝不看到半构造状态。无 capability/WeakMap/token/形式化状态机。"""

    __slots__ = (
        "status",  # "OK" 或 VOICE_REGISTRY_* 错误码
        "voices",
        "loaded_registry_sha256",  # 当前加载文件原始 bytes 的单一 SHA-256（frozen registry identity，无额外 hash 层）
        "loaded_registry_generation",  # 1.1 的 registryGeneration；1.0/未加载 → None
        "publisher_schema_version",  # 1.1 的 publisherSchemaVersion；1.0/未加载 → None
        "schema_version",  # 当前加载文件的 schemaVersion；未加载 → None
        "last_reload_error",  # 最近一次失败 reload 的 VOICE_REGISTRY_* 码；无 → None
        "degraded",  # True = 上次 reload 失败，正以 LKG 运行
    )

    def __init__(self, status: str, voices: Optional[Dict[str, VoiceEntry]] = None, *,
                 loaded_registry_sha256: Optional[str] = None,
                 loaded_registry_generation: Optional[int] = None,
                 publisher_schema_version: Optional[str] = None,
                 schema_version: Optional[str] = None,
                 last_reload_error: Optional[str] = None,
                 degraded: bool = False) -> None:
        self.status = status
        self.voices = voices or {}
        self.loaded_registry_sha256 = loaded_registry_sha256
        self.loaded_registry_generation = loaded_registry_generation
        self.publisher_schema_version = publisher_schema_version
        self.schema_version = schema_version
        self.last_reload_error = last_reload_error
        self.degraded = degraded


class _RegistryLoad:
    """_load_registry_file 的结果；status != "OK" 时其余字段无意义。"""

    __slots__ = ("status", "voices", "sha256", "generation", "publisher_version", "schema_version")

    def __init__(self, status: str, voices: Optional[Dict[str, VoiceEntry]] = None,
                 sha256: Optional[str] = None, generation: Optional[int] = None,
                 publisher_version: Optional[str] = None, schema_version: Optional[str] = None) -> None:
        self.status = status
        self.voices = voices
        self.sha256 = sha256
        self.generation = generation
        self.publisher_version = publisher_version
        self.schema_version = schema_version


def _validate_reference_file(voice: VoiceEntry) -> str:
    """验证单个 reference 文件：存在 + 普通文件 + 可读 + 实际 SHA-256 == registry
    referenceSha256。返回 "" 表示可用，否则返回错误码：
      REFERENCE_VOICE_MISSING   — 不存在 / 非普通文件 / 不可读（reference 不可用）
      REFERENCE_SHA256_MISMATCH — 内容与 registry 声明不一致
    带 (mtime_ns, size) 缓存；校验通过时顺便填充 voice._sig / _actual_sha256 /
    expected_md5，避免成功 reload 后第一次 synthesize 重复读同一文件。
    错误码复用既有 frozen 语义（synthesize/health 的 REFERENCE_* 码，m4b 测试锁定），
    不引入新码——避免 ack / health / synthesize 三处错误码面漂移。"""
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
        try:
            with open(voice.reference_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    sha.update(chunk)
                    md5.update(chunk)
        except OSError:
            # 不可读与缺失同属「reference 不可用」：沿用 MISSING 码（既有 frozen 语义）
            return "REFERENCE_VOICE_MISSING"
        voice._sig = sig
        voice._actual_sha256 = sha.hexdigest()
        voice.expected_md5 = md5.hexdigest()
    if voice._actual_sha256 != voice.reference_sha256:
        return "REFERENCE_SHA256_MISMATCH"
    return ""


def _load_registry_file() -> _RegistryLoad:
    """读取并完整验证配置的固定 registry 路径（ADAPTER_VOICE_REGISTRY_PATH）。
    任何非法 → 非 OK（不 crash，由 HTTP 层表达 unready/degraded）。
    只读：绝不自动改写 registry 文件。"""
    if not VOICE_REGISTRY_PATH:
        return _RegistryLoad("VOICE_REGISTRY_NOT_CONFIGURED")
    try:
        with open(VOICE_REGISTRY_PATH, "rb") as fh:
            raw_bytes = fh.read()
    except OSError:
        return _RegistryLoad("VOICE_REGISTRY_UNREADABLE")
    file_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    try:
        data = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _RegistryLoad("VOICE_REGISTRY_INVALID")
    schema_version = data.get("schemaVersion") if isinstance(data, dict) else None
    if schema_version not in SUPPORTED_REGISTRY_SCHEMA_VERSIONS:
        return _RegistryLoad("VOICE_REGISTRY_UNSUPPORTED_SCHEMA")
    generation: Optional[int] = None
    publisher_version: Optional[str] = None
    if schema_version == PUBLISHER_REGISTRY_SCHEMA_VERSION:
        raw_generation = data.get("registryGeneration")
        # bool 是 int 子类——显式排除；registryGeneration 必须 positive integer
        if not (isinstance(raw_generation, int) and not isinstance(raw_generation, bool) and raw_generation >= 1):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        generation = raw_generation
        publisher_version = data.get("publisherSchemaVersion")
        if publisher_version != SUPPORTED_PUBLISHER_SCHEMA_VERSION:
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
    voices = data.get("voices")
    if not isinstance(voices, list) or len(voices) == 0:
        return _RegistryLoad("VOICE_REGISTRY_INVALID")

    root_real = os.path.realpath(VOICE_ROOT)
    result: Dict[str, VoiceEntry] = {}
    for item in voices:
        if not isinstance(item, dict):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        profile = item.get("voiceProfile")
        revision = item.get("voiceRevision")
        speaker_name = item.get("speakerName")
        ref_path = item.get("referenceAssetPath")
        ref_sha = item.get("referenceSha256")
        if not (isinstance(profile, str) and profile.strip()):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        if not (isinstance(revision, str) and revision.strip()):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        if not (isinstance(speaker_name, str) and speaker_name.strip()):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        if not (isinstance(ref_path, str) and os.path.isabs(ref_path)):
            # 相对路径与 ../ 逃逸一并拒绝（realpath 后 containment 再兜底）
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        if not (isinstance(ref_sha, str) and SHA256_RE.match(ref_sha)):
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        key = f"{profile}@{revision}"
        if key in result:
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        # realpath 解析 symlink 后做 containment——symlink 逃逸在此被拒绝
        real = os.path.realpath(ref_path)
        if real != root_real and os.path.commonpath([root_real, real]) != root_real:
            return _RegistryLoad("VOICE_REGISTRY_INVALID")
        voice = VoiceEntry(profile, revision, speaker_name, real, ref_sha)
        # reference 文件完整验证（存在/普通文件/可读/SHA-256）——reload ack 与
        # 启动 ready 的前提：任一失败 → 本次加载非 OK（有 LKG → degraded 保留旧 ack；
        # 无 LKG → unready）。绝不带着坏 reference 给出 OK/ack。
        bad = _validate_reference_file(voice)
        if bad:
            return _RegistryLoad(bad)
        result[key] = voice
    return _RegistryLoad("OK", result, file_sha256, generation, publisher_version, schema_version)


def _initial_registry() -> RegistryState:
    """启动时加载。失败 → 非 OK（ready=false，不 crash，以便 Docker healthcheck
    表达 unready 而不是进程退出）。"""
    load = _load_registry_file()
    if load.status != "OK":
        return RegistryState(load.status)
    return RegistryState(
        "OK", load.voices,
        loaded_registry_sha256=load.sha256,
        loaded_registry_generation=load.generation,
        publisher_schema_version=load.publisher_version,
        schema_version=load.schema_version,
    )


REGISTRY = _initial_registry()
_registry_lock = threading.Lock()


def _registry_status_body(st: RegistryState) -> Dict[str, object]:
    return {
        "ready": st.status == "OK",
        "degraded": st.degraded,
        "schemaVersion": st.schema_version,
        "loadedRegistrySha256": st.loaded_registry_sha256,
        "loadedRegistryGeneration": st.loaded_registry_generation,
        "publisherSchemaVersion": st.publisher_schema_version,
        "speakerCount": len(st.voices),
        "detail": None if st.status == "OK" else st.status,
        "lastReloadError": st.last_reload_error,
    }


# ---------- /registry-status + /reload（TTS-C.1B.1）----------


@app.get("/registry-status")
async def registry_status() -> Response:
    """唯一 activation acknowledgment 观察面：loaded registry identity（内容
    SHA-256）+ generation + speakerCount + degraded/lastReloadError。始终 200。"""
    return JSONResponse(_registry_status_body(REGISTRY))


@app.post("/reload")
async def reload_registry() -> Response:
    """重新读取配置的固定 registry 路径并完整验证，成功后一次性原子替换内存
    state。不接受 caller 提供的任何路径/内容。
    失败且有 LKG：保持旧 state/旧 voices（synthesize 不受影响），degraded=true +
    lastReloadError，返回非 2xx；失败且无 LKG：维持 ready=false。"""
    load = _load_registry_file()
    global REGISTRY
    if load.status == "OK":
        new_state = RegistryState(
            "OK", load.voices,
            loaded_registry_sha256=load.sha256,
            loaded_registry_generation=load.generation,
            publisher_schema_version=load.publisher_version,
            schema_version=load.schema_version,
        )
        with _registry_lock:
            REGISTRY = new_state
        return JSONResponse(_registry_status_body(new_state))
    with _registry_lock:
        current = REGISTRY
        if current.status == "OK":
            # LKG：旧 state/旧 voices 完全保留，仅标记 degraded + 记录错误
            REGISTRY = RegistryState(
                current.status, current.voices,
                loaded_registry_sha256=current.loaded_registry_sha256,
                loaded_registry_generation=current.loaded_registry_generation,
                publisher_schema_version=current.publisher_schema_version,
                schema_version=current.schema_version,
                last_reload_error=load.status,
                degraded=True,
            )
            kept_lkg = True
        else:
            # 无 LKG：更新为最新失败状态，维持 unready
            REGISTRY = RegistryState(load.status, last_reload_error=load.status)
            kept_lkg = False
    return _err(
        500,
        "VOICE_REGISTRY_RELOAD_FAILED",
        f"registry reload 失败（{load.status}）；{'保持 LKG 继续服务' if kept_lkg else '无可用 LKG，synthesize 维持 503'}",
    )


def _check_voice(voice: VoiceEntry) -> str:
    """synthesize/health 用 reference 校验（兼容包装，错误码为既有 frozen 语义）。
    文件在校验后被篡改时按 (mtime_ns, size) 缓存失效重算，fail-closed。"""
    return _validate_reference_file(voice)


# ---------- /health ----------


@app.get("/health")
async def health() -> Response:
    """ready=true 当且仅当：upstream 可达 AND registry 有效 AND 每个 voice 的
    reference 文件存在且 SHA-256 与 registry 一致。进程存活但任一条件不满足
    时 ready=false（Adapter 自身仍 200 返回 JSON）。LKG degraded 运行视为
    healthy（ready=true + degraded=true + detail=最近 reload 失败码）。"""
    st = REGISTRY  # 单次快照引用：reload 原子替换中途绝不看到半构造状态
    upstream_ok = False
    try:
        client = _client_or_create()
        res = await client.get("/speakers", timeout=HEALTH_TIMEOUT_SEC)
        upstream_ok = res.status_code == 200
    except Exception:
        upstream_ok = False

    detail = ""
    if st.status != "OK":
        detail = st.status
    else:
        for voice in st.voices.values():
            detail = _check_voice(voice)
            if detail:
                break
    ready = upstream_ok and not detail
    # fp16 / repoCommit：均无法取得真实值——字段直接省略，绝不返回 null 占位、绝不伪造
    body: Dict[str, object] = {
        "ready": ready,
        "provider": "indextts2",
        "model": MODEL_NAME,
        "degraded": st.degraded,
    }
    if not ready:
        body["detail"] = detail or "UPSTREAM_UNAVAILABLE"
    elif st.degraded and st.last_reload_error:
        body["detail"] = st.last_reload_error
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
    st = REGISTRY  # 快照：本请求自始至终读同一完整 state（reload 原子替换安全）
    if st.status != "OK":
        # REFERENCE_*（reference 文件问题）透传既有码（m4b frozen 语义，冷启动
        # reference 缺失/SHA 错误时 synthesize 保持原 503 码）；
        # VOICE_REGISTRY_*（registry 自身问题）对外统一 VOICE_REGISTRY_INVALID（既有语义）
        if st.status in ("REFERENCE_VOICE_MISSING", "REFERENCE_SHA256_MISMATCH"):
            return _err(503, st.status, f"voice registry 不可用（{st.status}）")
        return _err(503, "VOICE_REGISTRY_INVALID", f"voice registry 不可用（{st.status}）")
    revision = req.voiceRevision or ""
    voice = st.voices.get(f"{req.voiceProfile}@{revision}")
    if voice is None:
        if any(v.profile == req.voiceProfile for v in st.voices.values()):
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
