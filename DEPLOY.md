# 知影 M1 飞牛 NAS 部署指南

目标环境：飞牛 NAS（fnOS），Docker 已可用。架构为「单镜像、双服务」：`web`（Next.js，3000 端口）+ `worker`（Remotion 渲染，`cpus: 4 / mem_limit: 6g`）。

## 0. 前置条件

- NAS 可访问互联网（构建时需拉取 node 镜像、apt 包、pnpm 依赖、Chrome Headless Shell）
- 项目目录已完整拷至 NAS，例如 `/vol1/docker/zhiying/`
- 已运行过一次 `pnpm install` 生成 `pnpm-lock.yaml`（在开发机上即可，`pnpm install --frozen-lockfile` 构建期需要 lockfile）
- `public/` 目录已就位（约 455MB 媒体资源，运行时只读挂载，不进镜像）

## 1. 准备环境文件

```bash
cd /vol1/docker/zhiying
cp .env.example .env
# 默认即可：ZHIYING_DATA_DIR=/app/data、WORKER_ROLE=all、PORT=3000
# 如 3000 端口被占用，改 docker-compose.yml 左侧映射（如 "3100:3000"），不要改 PORT
```

## 2. 构建镜像

```bash
docker compose build
```

首次构建较久（10–30 分钟，视 NAS 性能与网络）：apt 依赖 → pnpm 全量安装 → Remotion 下载 Chrome Headless Shell → Next 构建。只要 `Dockerfile`、`pnpm-lock.yaml`、`src/`、`next.config.ts` 不变，后续重建命中缓存，速度很快。

## 3. 启动

```bash
docker compose up -d
docker compose ps        # web / worker 均应 running
```

飞牛界面操作：在「Docker → Compose」中导入本目录，或用 SSH 执行上述命令，二者等价。

## 4. 验证

```bash
# web 健康
curl -s http://<NAS-IP>:3000/api/projects | head -c 200
# worker 正常进入调度循环
docker logs zhiying-worker -f   # 应看到 bundle 缓存检查 / 调度日志，无反复重启
```

浏览器打开 `http://<NAS-IP>:3000`：项目列表页 → 导入样例 `samples/FullCutScenes.json` → 项目详情 Player 预览 → 导出成片 → /jobs 观察进度 → 完成后下载 mp4，即渲染闭环验证通过。

## 5. 数据与备份

全部运行时状态都在 **`./data/`** 一个目录里：

```
data/zhiying.db            # SQLite（WAL 模式）
data/bundle-cache/         # Remotion bundle 缓存（可重建，不必备份）
data/projects/…/renders/   # 渲染输出 mp4（用户资产，要备份）
```

备份（停机或运行中均可，SQLite WAL 支持在线拷贝；停机备份最稳妥）：

```bash
docker compose stop          # 可选
tar czf zhiying-backup-$(date +%F).tar.gz data/
docker compose start         # 可选
```

注意排除 `data/bundle-cache/` 可显著缩小备份体积（首次渲染会自动重建）。`public/` 是原始媒体资产，建议按 NAS 常规资产目录另行备份。

## 6. 常见问题

- **worker 容器内存紧张**：`mem_limit: 6g` 是契约约定值；NAS 内存 <8GB 时可下调至 4g，但 1080p 长片渲染稳定性会受影响。
- **渲染首单较慢**：首次渲染会构建 bundle 缓存（写入 `data/bundle-cache/`），之后的渲染复用缓存。
- **public 未挂载 / 路径不对**：表现为 Player 黑屏、音频缺失。确认 compose 所在目录下存在 `public/full/`。
- **修改代码后**：`docker compose build && docker compose up -d` 即可重建部署。
