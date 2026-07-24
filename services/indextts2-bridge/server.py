"""Zhiying IndexTTS2 Bridge（知影 TTS sidecar）

知影生产架构：Node Worker --HTTP--> 本服务（GPU/Python/模型常驻显存）。
官方 IndexTTS2（index-tts/index-tts）在其官方 uv 环境内加载一次，
之后所有 /v1/synthesize 请求复用同一模型实例。

运行（在官方 IndexTTS2 仓库同级目录或已配置 INDEXTTS2_HOME 时）：

    uvicorn server:app --host 127.0.0.1 --port 9880

必需环境变量：
    INDEXTTS2_CHECKPOINTS   官方 checkpoints 目录（含 config.yaml）
    ZHIYING_VOICE_DIR       voice profile 目录（default.wav 等，白名单映射）

可选：
    INDEXTTS2_REPO_COMMIT   health 返回用（建议部署时记录为 immutable commit）
    INDEXTTS2_FP16          "true"(默认) / "false"
    INDEXTTS2_USE_DEEPSPEED "false"(默认)
    INDEXTTS2_USE_CUDA_KERNEL "false"(默认)
"""

from __future__ import annotations

import io
import os
import threading
import wave
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

CHECKPOINTS = os.environ.get("INDEXTTS2_CHECKPOINTS", "checkpoints")
VOICE_DIR = os.environ.get("ZHIYING_VOICE_DIR", "voices")
REPO_COMMIT = os.environ.get("INDEXTTS2_REPO_COMMIT", "unknown")
FP16 = os.environ.get("INDEXTTS2_FP16", "true").lower() == "true"
USE_DEEPSPEED = os.environ.get("INDEXTTS2_USE_DEEPSPEED", "false").lower() == "true"
USE_CUDA_KERNEL = os.environ.get("INDEXTTS2_USE_CUDA_KERNEL", "false").lower() == "true"

app = FastAPI(title="zhiying-indextts2-bridge")
_lock = threading.Lock()
_tts = None


def _load_model():
    """惰性加载（首请求或启动时一次）。"""
    global _tts
    if _tts is not None:
        return _tts
    with _lock:
        if _tts is not None:
            return _tts
        from indextts.infer_v2 import IndexTTS2  # 官方包（不在本仓库内）

        cfg = os.path.join(CHECKPOINTS, "config.yaml")
        _tts = IndexTTS2(
            cfg_path=cfg,
            model_dir=CHECKPOINTS,
            use_fp16=FP16,
            use_deepspeed=USE_DEEPSPEED,
            use_cuda_kernel=USE_CUDA_KERNEL,
        )
        return _tts


def _voice_path(profile: str, revision: str) -> str:
    """voice ID → 白名单文件（禁止任意路径）。"""
    safe = "".join(c for c in profile if c.isalnum() or c in ("-", "_"))
    if not safe or safe != profile:
        raise HTTPException(status_code=422, detail=f"invalid voiceProfile: {profile!r}")
    name = f"{safe}@{revision}.wav" if revision else f"{safe}.wav"
    candidate = os.path.join(VOICE_DIR, name)
    if not os.path.isfile(candidate):
        fallback = os.path.join(VOICE_DIR, f"{safe}.wav")
        if os.path.isfile(fallback):
            return fallback
        raise HTTPException(status_code=404, detail=f"voice profile not found: {name}")
    return candidate


@app.get("/health")
def health() -> dict:
    ready = _tts is not None or os.path.isfile(os.path.join(CHECKPOINTS, "config.yaml"))
    voices = []
    if os.path.isdir(VOICE_DIR):
        voices = sorted(f[:-4] for f in os.listdir(VOICE_DIR) if f.endswith(".wav"))
    return {
        "ready": bool(ready),
        "provider": "indextts2",
        "model": "IndexTTS-2",
        "repoCommit": REPO_COMMIT,
        "fp16": FP16,
        "voiceProfiles": voices,
    }


class SynthesizeRequest(BaseModel):
    text: str
    voiceProfile: str
    voiceRevision: Optional[str] = None
    useRandom: bool = False
    emotion: str = "none"


@app.post("/v1/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is empty")
    if req.emotion != "none":
        raise HTTPException(status_code=422, detail="emotion mode not enabled in this deployment")
    voice = _voice_path(req.voiceProfile, req.voiceRevision or "")
    tts = _load_model()
    # 官方 IndexTTS2.infer 当前返回 (sample_rate, waveform)；统一封装为 WAV。
    # 部署时请以实际 clone 的 infer_v2.py 签名再核对一次（见 README §验证）。
    sr, wav_data = tts.infer(
        spk_audio_prompt=voice,
        text=text,
        output_path=None,
        use_random=req.useRandom,
    )
    import numpy as np

    tmp = io.BytesIO()
    pcm16 = (np.clip(wav_data, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(tmp, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return Response(content=tmp.getvalue(), media_type="audio/wav")
