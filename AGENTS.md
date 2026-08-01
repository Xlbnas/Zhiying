# ZhiYing Agent 工作约定

本文件为 agent（AI 编码代理 / 接力 agent）在本仓库工作时的约束与速查。技术状态以
`docs/M7_IMPLEMENTATION_STATUS.md` 为准，部署细节见 `docs/PRODUCTION_BUILD_NETWORK.md` 与 `DEPLOY.md`。

## 仓库与开发机

- 开发机：`agentvm`，工作目录 `/home/agentvm/projects/ZhiYing`。
- 长期分支 `m7`；生产部署在飞牛宿主机完成（见下）。
- 开发、typecheck、测试、commit、push 在 agentvm 完成；backup、Docker build、
  migration、up、smoke 在宿主机完成。
- Git：禁止 `git add .` / `git add -A` / force push；精确暂存，fast-forward push。
- 提交信息风格：`type(scope): subject`，如 `fix(assets): ...` / `docs(m7): ...`。

## 生产环境

- 宿主机：`VoicelessXlbnas@192.168.31.56 -p 2264`（SSH key `~/.ssh/id_ed25519_feiniu`）。
- 部署根目录 `/vol1/1000/docker/zhiying`；备份目录 `/vol1/1000/backups/zhiying/`；
  DB `/vol1/1000/docker/zhiying/data/zhiying.db`；端口 3210。
- Compose：`docker-compose.production.yml` + `docker-compose.production.gpu.yml`，
  env 文件 `.env.production`（`ZHIYING_RELEASE_TAG=<deploy SHA>` 为部署锚点）。
- Secret 边界：`DEEPSEEK_API_KEY` / `LLM_PROVIDER` 只注入 worker；`APIYI_API_KEY`
  注入 web 与 worker；禁止把任何 secret 写入镜像、Git、日志。

## 构建网络（重要）

宿主机 Docker build 直连 remotion.media（Remotion browser 下载）极慢（~10KB/s），
node:https 不读取 HTTP_PROXY。**必须**使用固化的加速方案：

```bash
# 宿主机上：
scripts/production-build-network.sh start     # 起 CONNECT 隧道（nginx:alpine+socat，经 127.0.0.1:7890 代理）
scripts/production-build-network.sh check     # RUNNING / STOPPED（非零退出）
docker build --network=host \
  --add-host remotion.media:127.0.0.1 \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t zhiying:<tag> .
scripts/production-build-network.sh stop      # 构建完成后清理
```

- 镜像源/隧道不可用时**停止构建**，不得默默退回直连慢速构建。
- 临时 tunnel 容器不得作为 production 常驻依赖；构建完清理。
- 详细说明与验证数据见 `docs/PRODUCTION_BUILD_NETWORK.md`。

## 测试

- `pnpm typecheck`、`pnpm build`（agentvm）。
- 测试脚本在 `scripts/test-*.ts`（`npx tsx scripts/<name>.ts`），清单与基线见
  `docs/M7_IMPLEMENTATION_STATUS.md` §11。
- agentvm 无系统 ffmpeg；跑 TTS/音频类测试前
  `export PATH=/tmp/ffmpeg-master-latest-linux64-gpl/bin:$PATH`（完整 GPL 构建）。
- runner 镜像不含 `scripts/`；容器内跑测试用宿主同 SHA 的 scripts 只读挂载：
  `docker run --rm -v <repo>/scripts:/app/scripts ...`（image code SHA 必须与
  mounted scripts 来源 SHA 精确一致）。

## 里程碑边界

- M7.3B（Visual Sequences/Shots）及之后的工作未经指示不得开始。
- 不得创建 timing-reconciliation@2.0、M7 pipeline snapshot、迁移 asset bindings、
  切换任何项目到 m7。
- 旧 candidate `793c80fa-9229-4551-bc05-960c727afa2e` 只读 revalidate，禁止删除/覆盖。
- 不自动重新生成污染项目 TTS；不循环重试 S001-R01 图片生成。
