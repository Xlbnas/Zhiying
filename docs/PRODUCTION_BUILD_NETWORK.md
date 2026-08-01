# 知影 Production 构建网络加速（Runbook）

> M7.3A.3 固化的生产构建网络方案。宿主机为飞牛 NAS（`Xlbnas-Shelter`），
> 部署根目录 `/vol1/1000/docker/zhiying`，SSH
> `VoicelessXlbnas@192.168.31.56 -p 2264`（key `~/.ssh/id_ed25519_feiniu`）。

## 1. 问题

`Dockerfile` 的 `RUN npx remotion browser ensure` 会从
`https://remotion.media/chromium-headless-shell-linux-x64-149.0.7790.0.zip`（约 96MB）
下载 Chrome Headless Shell：

- 宿主机直连该 Cloudflare CDN 实测 **~10KB/s**（构建会挂起数小时；且 remotion 的
  下载用 `node:https`，**不读取 HTTP_PROXY 环境变量**，普通 `--build-arg
  HTTP_PROXY=...` 对它无效）；
- apt/npm 镜像源只能加速 apt 与 npm，无法覆盖该下载；
- `chrome-devtools-frontend.appspot.com` 等旧域名在宿主机网络不可达；
- 断连时 remotion 不会报错退出，而是无限挂起（无超时）。

## 2. 部署拓扑

```
宿主机 127.0.0.1:7890（xray 代理，loopback-only）
        ▲ CONNECT remotion.media:443
        │
tunnel-remotion-build 容器（nginx:alpine + socat，--network=host）
        │ socat TCP-LISTEN:443 → PROXY:127.0.0.1:remotion.media:443,proxyport=7890
        ▲
Docker build RUN 容器（--network=host + --add-host remotion.media:127.0.0.1）
        │ node:https GET https://remotion.media/...（TLS 端到端到真实服务器）
```

要点：

- `--network=host`：RUN 容器共享宿主网络栈 → `127.0.0.1:443` 即宿主的 socat 隧道；
  这是 Docker build 中普通 bridge 容器做不到的（容器内 127.0.0.1 不是宿主）。
- `--add-host remotion.media:127.0.0.1`：RUN 容器内 DNS 把 remotion.media 指向
  本地隧道（buildkit 会把这个 hosts 条目注入每个 RUN 容器）。
- socat `PROXY:` 模式向 7890 发 `CONNECT remotion.media:443`，建立隧道后纯透传；
  TLS 在 node 与真实服务器之间端到端完成，证书校验不受影响。
- 容器内以 root 运行（nginx:alpine 默认 root），可绑定 <1024 端口 443；
  宿主侧只需要 docker 权限，**不需要 sudo**。
- 不修改 xray 配置、不开放 7890 到非 loopback、不把任何代理凭据写入镜像/Git。

## 3. 标准参数

| 项 | 值 |
|---|---|
| 镜像 | `nginx:alpine`（本地已有，无需拉取） |
| 容器名 | `tunnel-remotion-build`（固定，幂等） |
| 代理 | `127.0.0.1:7890`（loopback only） |
| 隧道端口 | `443` |
| apt 镜像 | `--build-arg APT_MIRROR=mirrors.aliyun.com` |
| npm 镜像 | `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` |

## 4. 用法（宿主机）

```bash
cd /vol1/1000/docker/zhiying

# 1) 启动隧道（幂等；443 被未知服务占用时拒绝并非零退出；start 失败自动清理）
scripts/production-build-network.sh start

# 2) 健康检查
scripts/production-build-network.sh check      # RUNNING → 0；STOPPED → 1

# 3) 可选：验证隧道速度（实测 ~1.4–2 MB/s）
timeout 15 curl -s --resolve remotion.media:443:127.0.0.1 \
  -o /dev/null -w "tunnel_speed=%{speed_download} B/s\n" \
  -r 0-2000000 https://remotion.media/chromium-headless-shell-linux-x64-149.0.7790.0.zip

# 4) 构建（精确 SHA，带加速参数）
docker build --network=host \
  --add-host remotion.media:127.0.0.1 \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  --build-arg http_proxy=http://127.0.0.1:7890 \
  --build-arg https_proxy=http://127.0.0.1:7890 \
  --build-arg NO_PROXY=localhost,127.0.0.1,172.17.0.0/16 \
  --build-arg no_proxy=localhost,127.0.0.1,172.17.0.0/16 \
  -t zhiying:<TARGET_SHA> .

# 5) 构建完成后清理隧道（不得作为 production 常驻依赖）
scripts/production-build-network.sh stop
```

说明：

- `--network=host` 使 RUN 层的 Docker 层缓存键变化（hosts 内容不同），首次会
  全量重建；各步骤走镜像源/代理后总时长约 25–35 分钟（apt → pnpm → browser →
  next build），可接受。
- 代理 build-args 是 Docker 预定义参数（无需 Dockerfile 声明），会注入 RUN 环境，
  对 apt/pnpm（走代理的工具）生效；remotion 的 node:https 不走它，由隧道覆盖。
- 端口占用检查：`scripts/production-build-network.sh start` 会先检查 443 是否被
  占用（`ss -lnt`），占用则拒绝启动。

## 5. 失败回滚

- 隧道起不来：`scripts/production-build-network.sh check` 非零 → 看
  `docker logs tunnel-remotion-build`（常见：apk 装 socat 失败=代理不可达）。
- 构建中途失败：buildkit 已提交的层仍缓存（重试不重跑已完成的步骤）。
- 部署回滚：宿主机 git 仓库有全部历史 SHA；镜像 tag=SHA 是版本锚点；
  `git checkout --detach <旧SHA>` → 重新 build → `up -d`。
- **禁止**：代理不可达时继续慢速直连构建；把隧道容器长期保留。

## 6. 实测数据（2026-07-31）

| 路径 | 速率 |
|---|---|
| 宿主机直连 remotion.media（IPv4/IPv6） | ~60–130 KB/s |
| Docker build 容器直连 | ~10 KB/s（挂起数小时） |
| 经 7890 代理（宿主 curl） | ~1.42 MB/s |
| 经 CONNECT 隧道（curl --resolve） | ~2.06 MB/s |
| browser ensure 步骤（隧道） | 96MB 约 3–4 分钟（含 apk socat） |

## 7. 安全边界

- 不把代理地址/凭据写入镜像层、Git、日志；`ZHIYING_BUILD_PROXY` 默认
  loopback-only。
- 隧道只做 remotion.media:443 的 CONNECT 转发；不监听外部接口（--network=host
  下 socat 仅绑 443，宿主防火墙按现状）。
- 构建结束必须 `stop`；脚本幂等、trap 清理、失败非零退出。
