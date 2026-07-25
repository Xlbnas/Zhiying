# 知影 · AI 知识视频工坊 — M4-B 一体化镜像（web + worker 共用，non-root）
# CONTRACT §7：node:22-bookworm + Chrome Headless Shell 运行依赖 + ffmpeg
# （M1 原契约 node:20-bookworm；pnpm@11.9.0 依赖 node:sqlite（Node≥22），
#   且开发机实证 node v22，故 M4-B 对齐为 node:22-bookworm）
# M4-B 变更：
#   - fonts-noto-cjk（Linux 容器内中文字幕渲染；此前依赖宿主字体 fallback）
#   - USER node（uid 1000，与 Feiniu 宿主 VoicelessXlbnas 对齐）
#   - Chrome Headless Shell → /home/node/.cache/remotion
#   - COREPACK_HOME 共享位置（root 准备的 pnpm 对 node 用户可用）
# 说明：public/（约 455MB 媒体资源）与 data/ 不打进镜像，运行时由 compose volume 挂载。

# ---------- base：pnpm 环境 ----------
FROM node:22-bookworm AS base
# COREPACK_HOME 放到共享路径：root 在构建期 prepare 的 pnpm，runner 阶段
# node 用户可直接使用（默认 ~/.cache/node/corepack 会随用户切换而失效）
ENV COREPACK_HOME=/opt/corepack
# package.json packageManager 字段锁定 pnpm@11.9.0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate \
    && chmod -R a+rX /opt/corepack

# ---------- system：Chrome Headless Shell + ffmpeg + CJK 字体运行依赖 ----------
# 依赖清单依据 Remotion 官方 Docker 文档（node:20-bookworm）
FROM base AS system
# 可选 apt 镜像（默认官方 deb.debian.org；网络受限环境用 --build-arg
# APT_MIRROR=mirrors.aliyun.com 等覆盖，不影响默认行为）
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
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
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    # fonts-noto-cjk 单独安装：54MB 大包在受限网络下单次 apt 下载易断，
    # 改用 curl 断点续传 + dpkg（依赖仅 fontconfig，已在上方安装）
    && for i in 1 2 3 4 5; do \
      curl -fL --retry 5 --retry-delay 2 -C - -o /tmp/fonts-noto-cjk.deb \
        "http://${APT_MIRROR:-deb.debian.org}/debian/pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20220127+repack1-1_all.deb" \
        && break || sleep 3; \
    done \
    && dpkg -i /tmp/fonts-noto-cjk.deb \
    && rm -f /tmp/fonts-noto-cjk.deb

# ---------- deps：安装全部依赖 + 预下载 Chrome Headless Shell ----------
FROM system AS deps
WORKDIR /app
# pnpm-workspace.yaml 必须同步拷贝：allowBuilds（better-sqlite3/esbuild/sharp
# 的构建脚本白名单）在其中，缺失会 ERR_PNPM_IGNORED_BUILDS
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 可选 npm registry 镜像（默认官方 registry.npmjs.org；网络受限环境用
# --build-arg NPM_REGISTRY=https://registry.npmmirror.com 覆盖）
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then pnpm config set registry "$NPM_REGISTRY"; fi \
    && pnpm install --frozen-lockfile
# 在构建期下载 Remotion 渲染用的 Chrome Headless Shell，避免容器首次渲染时
# 才联网下载。Remotion 4.x 将 browser 装入项目 node_modules/.remotion/
# （非 ~/.cache/remotion），runner 随 node_modules 一并获得。
RUN npx remotion browser ensure

# ---------- build：构建 Next 产物 ----------
FROM deps AS build
# .dockerignore 已排除 data/ public/full public/pilot node_modules .next samples
COPY . .
RUN pnpm build

# ---------- runner：生产运行镜像（non-root, uid=1000）----------
# next.config.ts 未开启 standalone 输出，故保留完整 node_modules
# （worker 运行需要 devDependency tsx，因此不裁剪 dev 依赖）
FROM system AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    ZHIYING_DATA_DIR=/app/data \
    WORKER_ROLE=all \
    HOME=/home/node

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
# Chrome Headless Shell 已随 node_modules（.remotion/）进入镜像
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json tsconfig.json next.config.ts ./
COPY --chown=node:node src ./src
# data/ 与 public/ 由 compose volume 挂载；image 内仅建空目录占位并修正属主
# （/app 本身也必须 node 可写：pnpm/Next 运行时会在 WORKDIR 写临时文件与
#  .next/cache。宿主 bind mount 权限模型见 docs/M4_生产部署.md：data 需
#  uid 1000 RW，public 需 uid 1000 read/traverse；不要 chmod 777）
RUN mkdir -p /app/data /app/public && chown node:node /app /app/data

# pnpm 11 默认 verify-deps-before-run 会在 start/worker 前触发 install 检查并
# 改写 node_modules——生产镜像依赖已冻结，显式关闭
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

USER node

EXPOSE 3000

# 默认启动 web；worker 由 compose 用 `pnpm worker` 覆盖
CMD ["pnpm", "start"]
