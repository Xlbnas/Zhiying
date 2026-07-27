#!/usr/bin/env bash
# M4-C1B2-R5A — IndexTTS2 HF runtime artifact preflight（canonical，fail-closed）
#
# 职责：在任何 production compose mutation 前，验证目标 IndexTTS2 image 具备
# 完整 offline HuggingFace runtime artifacts。 disposable container：
#   --rm --pull=never --network none，无 GPU，不 mount 任何 host 路径，
#   HF_HUB_CACHE=/app/checkpoints/hf_cache + HF_HUB_OFFLINE=1。
# 逐项用镜像内真实 Python library 解析 4 个启动必需 artifact，并要求 resolved
# realpath 全部位于 /app/checkpoints/hf_cache/ 下（禁止误命中
# /root/.cache/huggingface writable-layer 增量）。
#
# 用法：preflight-indextts2-hf-cache.sh <image-ref>
# 成功唯一标记：HF_RUNTIME_ARTIFACT_PREFLIGHT=PASS（exit 0）
# 任一 artifact 缺失/路径错误：exit != 0 并输出 repo / filename / 失败原因。
#
# 本脚本禁止：拉取或构建镜像、对 production compose 做任何 up/down、停止或
# 重启任何 production container、任何 online fallback。
set -euo pipefail

IMG="${1:-}"
if [ -z "$IMG" ]; then
  echo "FAIL: image ref 参数为空（用法：$0 <image-ref>）" >&2
  exit 1
fi

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "FAIL: image 本地不存在且禁止 pull：$IMG" >&2
  exit 1
fi

echo "HF preflight image=$IMG（--rm --pull=never --network none，无 GPU，无 host mount）"

docker run --rm -i --pull=never --network none \
  -e HF_HUB_CACHE=/app/checkpoints/hf_cache \
  -e HF_HUB_OFFLINE=1 \
  --entrypoint /app/.venv/bin/python \
  "$IMG" - <<'PYEOF'
import os
import sys

BASE = "/app/checkpoints/hf_cache"
fails = []


def chk(path, label):
    """resolved path 必须真实存在且位于 image-baked HF_HUB_CACHE 下。"""
    rp = os.path.realpath(path)
    if not rp.startswith(BASE + "/"):
        fails.append((label, "wrong-cache-base", rp))
        print(f"PREFLIGHT_ITEM_FAIL {label}: wrong-cache-base {rp}")
        return None
    if not os.path.exists(rp):
        fails.append((label, "resolved-path-missing", rp))
        print(f"PREFLIGHT_ITEM_FAIL {label}: resolved-path-missing {rp}")
        return None
    print(f"PREFLIGHT_ITEM_OK {label}: {rp}")
    return rp


def attempt(label, repo, filename, fn):
    try:
        return chk(fn(), label)
    except Exception as e:  # noqa: BLE001 — preflight 须报告任何解析失败
        fails.append((label, repo, filename, type(e).__name__, str(e)[:200]))
        print(f"PREFLIGHT_ITEM_FAIL {label}: repo={repo} file={filename} "
              f"{type(e).__name__}: {str(e)[:200]}")
        return None


from huggingface_hub import hf_hub_download

r = attempt("MaskGCT", "amphion/MaskGCT", "semantic_codec/model.safetensors",
            lambda: hf_hub_download("amphion/MaskGCT",
                                    filename="semantic_codec/model.safetensors"))
print("MaskGCT=" + ("PASS" if r else "FAIL"))

r = attempt("campplus", "funasr/campplus", "campplus_cn_common.bin",
            lambda: hf_hub_download("funasr/campplus",
                                    filename="campplus_cn_common.bin"))
print("campplus=" + ("PASS" if r else "FAIL"))

# filename 以镜像内 indextts/BigVGAN/bigvgan.py 实际 hf_hub_download 调用为准
# （config.json / bigvgan_generator.pt，已核对 _from_pretrained 源码行）
b1 = attempt("BigVGAN.config", "nvidia/bigvgan_v2_22khz_80band_256x", "config.json",
             lambda: hf_hub_download("nvidia/bigvgan_v2_22khz_80band_256x",
                                     filename="config.json"))
b2 = attempt("BigVGAN.generator", "nvidia/bigvgan_v2_22khz_80band_256x", "bigvgan_generator.pt",
             lambda: hf_hub_download("nvidia/bigvgan_v2_22khz_80band_256x",
                                     filename="bigvgan_generator.pt"))
print("BigVGAN=" + ("PASS" if (b1 and b2) else "FAIL"))

fe_ok = False
try:
    from transformers import SeamlessM4TFeatureExtractor
    fe = SeamlessM4TFeatureExtractor.from_pretrained(
        "facebook/w2v-bert-2.0", local_files_only=True)
    print(f"PREFLIGHT_ITEM_OK w2v-bert-2.0.feature_extractor: {type(fe).__name__}")
    fe_ok = True
except Exception as e:  # noqa: BLE001
    fails.append(("w2v-bert-2.0.feature_extractor", "facebook/w2v-bert-2.0",
                  "preprocessor_config.json", type(e).__name__, str(e)[:200]))
    print(f"PREFLIGHT_ITEM_FAIL w2v-bert-2.0.feature_extractor: "
          f"repo=facebook/w2v-bert-2.0 {type(e).__name__}: {str(e)[:200]}")

w1 = attempt("w2v-bert-2.0.config", "facebook/w2v-bert-2.0", "config.json",
             lambda: hf_hub_download("facebook/w2v-bert-2.0", filename="config.json"))
w2 = attempt("w2v-bert-2.0.weights", "facebook/w2v-bert-2.0", "model.safetensors",
             lambda: hf_hub_download("facebook/w2v-bert-2.0", filename="model.safetensors"))
w3 = attempt("w2v-bert-2.0.preprocessor", "facebook/w2v-bert-2.0", "preprocessor_config.json",
             lambda: hf_hub_download("facebook/w2v-bert-2.0",
                                     filename="preprocessor_config.json"))
print("W2V_BERT=" + ("PASS" if (fe_ok and w1 and w2 and w3) else "FAIL"))

if fails:
    print(f"HF_RUNTIME_ARTIFACT_PREFLIGHT=FAIL items={len(fails)}")
    sys.exit(4)
print("HF_RUNTIME_ARTIFACT_CLOSURE=PASS")
PYEOF

echo "HF_RUNTIME_ARTIFACT_PREFLIGHT=PASS"
