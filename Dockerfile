# syntax=docker/dockerfile:1
# 知影 · AI 知识视频工坊 — M1 一体化镜像（web + worker 共用）
# CONTRACT §7：node:20-bookworm + Chrome Headless Shell 运行依赖 + ffmpeg
# 说明：public/（约 455MB 媒体资源）不打进镜像，运行时由 compose 以只读 volume 挂载。

# ---------- base：pnpm 环境 ----------
FROM node:20-bookworm AS base
# package.json packageManager 字段锁定 pnpm@11.9.0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# ---------- system：Chrome Headless Shell + ffmpeg 运行依赖 ----------
# 依赖清单依据 Remotion 官方 Docker 文档（node:20-bookworm）
FROM base AS system
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm-dev \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ---------- deps：安装全部依赖 + 预下载 Chrome Headless Shell ----------
FROM system AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# 在构建期下载 Remotion 渲染用的 Chrome Headless Shell，
# 避免容器首次渲染时才联网下载（缓存于 /root/.cache/remotion）
RUN npx remotion browser ensure

# ---------- build：构建 Next 产物 ----------
FROM deps AS build
# .dockerignore 已排除 data/ public/full public/pilot node_modules .next samples
COPY . .
RUN pnpm build

# ---------- runner：生产运行镜像 ----------
# next.config.ts 未开启 standalone 输出，故保留完整 node_modules
# （worker 运行需要 devDependency tsx，因此不裁剪 dev 依赖）
FROM system AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    ZHIYING_DATA_DIR=/app/data \
    WORKER_ROLE=all

COPY --from=deps /app/node_modules ./node_modules
# 预下载的 Chrome Headless Shell
COPY --from=deps /root/.cache/remotion /root/.cache/remotion
COPY --from=build /app/.next ./.next
COPY package.json tsconfig.json next.config.ts ./
COPY src ./src
# public/ 与 data/ 由 compose volume 挂载，不在镜像内

EXPOSE 3000

# 默认启动 web；worker 由 compose 用 `pnpm worker` 覆盖
CMD ["pnpm", "start"]
