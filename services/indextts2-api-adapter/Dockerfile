# Zhiying IndexTTS2 API Adapter — production image（M4-B）
# 极薄控制面：无 GPU / 无 torch / 无 privileged / 无 docker.sock / non-root
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# non-root runtime user（uid 1000，与 Feiniu 宿主 VoicelessXlbnas 对齐，便于
# voices/config 只读挂载的权限一致性）
RUN groupadd --gid 1000 adapter && useradd --uid 1000 --gid adapter --no-create-home adapter

WORKDIR /app

# 可选 pip 镜像（默认官方 pypi；网络受限环境用 --build-arg
# PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple 等覆盖）
ARG PIP_INDEX_URL=
COPY requirements.txt ./
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt; \
    else \
      pip install --no-cache-dir -r requirements.txt; \
    fi

# 只复制应用代码；.venv / reference WAV / 测试数据由 .dockerignore 排除
COPY server.py ./

USER adapter

EXPOSE 9880

# readiness = HTTP 成功 AND JSON ready==true（adapter 上游故障时故意 200+ready:false，
# 纯 curl -f 不合格；stdlib 实现，零新增依赖）
HEALTHCHECK --interval=15s --timeout=10s --start-period=10s --retries=6 \
  CMD ["python3", "-c", "import json,sys,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:9880/health',timeout=5)); sys.exit(0 if d.get('ready') is True else 1)"]

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9880"]
