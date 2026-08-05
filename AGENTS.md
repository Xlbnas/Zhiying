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

## 工程复杂度、验证强度与威胁模型

### 1. 默认威胁模型

知影当前默认是：单仓库、受控内部模块、受控 Worker、无第三方插件直接执行内部
代码、无恶意内部调用方、非公开多租户执行平台。

默认防御：普通程序 Bug、进程崩溃、重复请求、并发竞争、文件缺失或损坏、错误状态
迁移、production 配置错误、迁移破坏、用户可见错误结果。

默认不防：拥有仓库代码执行权的恶意内部模块、故意使用 `any` / `Object.defineProperty`
绕过内部 API、故意篡改 module-private record、拥有宿主机写权限的攻击者、理论上无限
组合的极低概率 corner case。只有用户明确改变威胁模型后，才能为这些情况增加复杂
安全边界。

### 2. SHA-256 使用边界

允许保留：Git commit exact SHA（版本与部署绑定）、不可变 Artifact 或音频内容的单一
canonical hash、现有 frozen contract 明确要求的 registry/artifact hash、文件损坏检测
所必需的一次内容 hash。

默认禁止新增：为每个中间步骤重复计算 SHA-256、为日志/测试输出/普通状态行/临时
evidence 建立 hash、hash-of-hash 或多层 hash chain、同一文件在多个模块反复维护不同
hash 身份、仅为了让 Review 看起来更严谨而新增 checksum、用 SHA-256 替代数据库 FK、
唯一约束、版本号或事务。

新增 hash 前必须说明：具体检测什么真实故障、该故障会造成什么用户或生产影响、为什么
ID/版本/事务/约束/普通测试不足、运行和维护成本是什么。无法回答则不得新增。

### 3. 复杂度预算

新增以下任一项前必须证明必要性：数据库表、trigger、状态、capability/token、WeakMap
authority、新 CI workflow、mutation runner、文件系统多层 seal、新 hash 字段、新
provenance 层。

必须先考虑更简单的方案：直接函数封装、数据库事务、FK / UNIQUE / CHECK、单个
integration test、明确错误返回、feature gate、日志和恢复流程。复杂方案只有在简单
方案无法覆盖真实生产风险时才允许使用。

### 4. Review 严重度

P0 仅用于：不可恢复数据损坏、覆盖或丢失已有生产文件、跨项目数据串联、错误发布影响
多个项目、绕过 production feature gate、破坏 production migration、错误结果被用户
当作成功使用、安全或隐私泄漏。

P1 用于：可恢复的正确性错误、稳定复现的资源泄漏、错误状态但不破坏既有数据、会明显
影响真实工作流的问题。

P2 / non-blocking 用于：内部 API 理论上可被故意误用、测试名称与实现不完全一致、
低概率资源释放问题、重复校验、维护性和性能优化、报告措辞问题。不得因为问题技术上
复杂，就自动提升为 P0。

### 5. Review 的阻断标准

Review FAIL 必须同时给出：精确代码路径、可复现步骤或测试、真实可达前置条件、用户或
production 影响、最小修复方案。

以下情况不得单独导致 FAIL：恶意内部模块可故意绕过、理论上可以通过 `any` 篡改、没有
真实调用路径的伪造对象、极低概率但无影响证明的 corner case、mutation 未杀死测试、
缺少额外 SHA 或额外 evidence、报告中的轻微数字或措辞错误。

### 6. Mutation testing

Mutation testing 是可选辅助工具，不是阶段冻结前置条件。默认：每个高风险模块最多
保留 3–5 个关键 mutation、不要求所有 protection 都有 mutation、不为 mutation runner
再建立多层验证系统、普通 integration test 是主要证据、mutation 无 observable effect
不代表 PASS 也不必继续追求。除非真实历史故障证明必要，不再为单一阶段新增独立
mutation CI workflow。现有 R7 workflow 可以作为历史收尾保留，但不得自然扩展到
TTS-C.1B / 1C / C.2。

### 7. 停止规则

一个局部功能经过一次实施、一次独立 Review、一次针对真实 blocker 的修复后，若核心
工作流、普通回归测试和 production gate 均正常，应优先冻结并推进下一阶段。继续增加
Review 轮次前必须证明存在新的真实生产风险，不能只因为还能构造理论反例。

### 8. 产品优先级

优先投入：用户能实际使用的工作流、逐句试听、局部重生成、版本对比、master 重拼接、
stale/invalidation、人工可控性、恢复能力。不得让底层验证基础设施长期阻塞这些能力。

### 9. TTS-C.1A 当前裁决

R7 是 TTS-C.1A 防御复杂度上限。后续独立 Review 使用 proportional-risk rubric。除非
发现真实可复现的 production blocker，否则不得启动 R8。不得继续扩展 SHA、capability、
inode seal 或 mutation gate。不得提前写 R7 Review PASS 或 1A FROZEN。
