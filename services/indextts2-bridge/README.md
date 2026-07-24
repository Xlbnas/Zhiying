# Zhiying IndexTTS2 Bridge（TTS Sidecar）

知影生产 TTS 架构：

```text
Zhiying Node Worker
  → HTTP (src/lib/tts/indextts2.ts)
  → 本服务（GPU / Python / 官方 IndexTTS2 常驻显存）
```

**不要**把 IndexTTS2 / PyTorch / CUDA 塞进 Next/Node 进程或知影 Docker 镜像；
**不要**通过 Gradio（官方 `webui.py`）作为生产入口——它只用于人工 demo。

## 一、安装（GPU 机器）

```bash
# 1. 官方仓库（immutable commit，记录 INDEXTTS2_REPO_COMMIT，勿随 main 漂移）
git clone https://github.com/index-tts/index-tts.git
cd index-tts
git checkout <INDEXTTS2_REPO_COMMIT>

# 2. 官方环境
uv sync

# 3. checkpoints（官方单独下载，勿提交 Git）
#    置于 index-tts/checkpoints/（含 config.yaml）

# 4. 本桥接（知影仓库内，无官方源码）
cd <zhiying>/services/indextts2-bridge
uv pip install fastapi uvicorn  # 在官方 uv 环境内
```

官方仓库曾有 history reset 提示：部署时务必记录实际 commit 哈希，
生产环境禁止 `git pull origin main` 后直接运行。

## 二、运行

```bash
export INDEXTTS2_CHECKPOINTS=/path/to/index-tts/checkpoints
export ZHIYING_VOICE_DIR=/path/to/voices        # default.wav 或 default@1.wav
export INDEXTTS2_REPO_COMMIT=<实际 commit 哈希>
export INDEXTTS2_FP16=true                      # baseline（见下）
export INDEXTTS2_USE_DEEPSPEED=false
export INDEXTTS2_USE_CUDA_KERNEL=false

uvicorn server:app --host 127.0.0.1 --port 9880
```

Baseline（correctness 优先，性能后调）：
`FP16=true / DeepSpeed=false / CUDA custom kernel=false / torch_compile=false`。
若 FP16 在目标 GPU 有兼容问题再降级 `INDEXTTS2_FP16=false` 并记录原因。

验收顺序：`nvidia-smi` → `uv run tools/gpu_check.py`（官方）→ 启动 bridge →
`curl localhost:9880/health`。

## 三、契约（与 src/lib/tts/indextts2.ts 对齐）

- `GET /health` → `{ready, provider, model, repoCommit, fp16, voiceProfiles[]}`
  `ready=false`（模型未加载/checkpoints 缺失）时 Worker 不发起合成。
- `POST /v1/synthesize`
  `{text, voiceProfile, voiceRevision, useRandom:false, emotion:"none"}`
  → `audio/wav`（PCM s16，采样率以官方 infer 输出为准；知影 master 阶段统一重采样到 48kHz/mono）。

**验证提示**：`server.py` 假设官方 `infer()` 返回 `(sample_rate, waveform)`。
部署时请以实际 clone 的 `indextts/infer_v2.py` 签名核对一次；
如有 `output_path` 参数差异，按官方当前签名微调本文件，勿改知影侧契约。

## 四、Voice Profile 语义

- `ZHIYING_VOICE_DIR` 内文件：`default.wav` 或 `default@<revision>.wav`。
- `voiceProfile` 仅允许白名单文件名（拒绝任意路径/穿越）。
- 换 reference audio = 人工 bump `voiceRevision`（`default@1.wav` → `default@2.wav`），
  因为同一文本在不同 reference 下已非同一生产条件。
- **reference voice 必须为用户本人、已获授权的声音或明确可用素材**；
  本目录不得默认附带第三方真人参考音频。

## 五、License

- IndexTTS2 模型与代码遵循官方 **Bilibili Model Use License**（非 Apache-2.0/MIT）。
- checkpoints / voice wav / 生成 WAV / HF cache / Python .venv **一律不入 Git**。
- 若知影未来商业化或对外分发，需重新做 IndexTTS2 license review（本轮不作法律判断）。

## 六、知影侧配置

```bash
# .env.local（不入库）
TTS_PROVIDER=indextts2
INDEXTTS2_BASE_URL=http://127.0.0.1:9880
```

production 下 `TTS_PROVIDER=mock` 会被拒绝（CONFIG_ERROR）；
sidecar 离线时 Web/LLM/Render 功能不受影响（TTS job 报 PROVIDER_UNAVAILABLE，不阻塞其他业务）。
