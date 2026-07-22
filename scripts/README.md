# scripts —— 样例导入与 round-trip 校验（CONTRACT §8）

样例数据：`samples/FullCutScenes.json`（复制自 `07_FullCut/FullCutScenes.json`，85 个 scene）。

脚本仅使用 Node 18+ 原生 `fetch`，无第三方依赖，可直接用 `node` 运行。

## 使用步骤

### 1. 启动本地服务

```bash
npm run dev   # 默认 http://localhost:3000
```

（如服务端口不同，设置环境变量 `BASE_URL`，例如 `BASE_URL=http://localhost:3001`。）

### 2. 导入样例项目

```bash
node scripts/import-sample.mjs
```

- 读取 `samples/FullCutScenes.json` 原文，`POST {BASE_URL}/api/projects/import`
- 成功时打印 `project id: <uuid>`
- 失败（网络错误 / 非 2xx / 响应缺 `project.id`）时打印响应体并以非零码退出

### 3. 校验 round-trip 无损

```bash
node scripts/verify-roundtrip.mjs <projectId>
```

- `GET {BASE_URL}/api/projects/<projectId>/scenes`（返回 `ZhiyingFullCutProps`）
- 与 `samples/FullCutScenes.json` 逐字段对比：
  - scene 总数 = 85
  - 每个 scene 的 `id` / 顺序 / `start` / `end` / `duration` / `startFrame` / `durationInFrames` / `template` / `category` 全部一致
- 输出逐项 `PASS` / `FAIL`，末尾给出汇总
- 任何不一致打印 diff 并以非零码退出；全部一致时输出「校验通过 ✅」并以 0 退出

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | 知影 Web 服务地址 |

## 常见问题

- **请求失败 / ECONNREFUSED**：确认已先执行 `npm run dev`，且端口与 `BASE_URL` 一致。
- **导入返回 422**：样例未通过服务端 `fullCutDataSchema` zod 校验，响应体会打印 issues。
- **verify 报「响应缺少 data.scenes」**：确认 API 返回的是 `ZhiyingFullCutProps` 结构（`{ data, subtitles, audio, showSubtitles }`）。

## 帧一致性验证（M1-04 验收资产）

验证 Player 与 Renderer 在同一帧、同一 props 下视觉一致。

### 1. Renderer 侧取帧

```bash
node scripts/render-frames.mjs <projectId> 0,3990,8175,12243
```

- 打包/复用 bundle 缓存（webpackOverride 与 `src/worker/index.ts` 相同）
- 从 API 拉取与 Player 同源的 `ZhiyingFullCutProps`
- 输出 `data/still-test/frame-<N>.png`

### 2. Player 侧截图

用 agent-browser 打开 `/project/<id>`，点击场景列表项（`seekTo(startFrame)` 精确对帧），隐藏 Player controls 后截取 `.player-frame` 区域，保存为 `data/still-test/pf-<N>.png`（N 与 Renderer 帧号一致）。

### 3. 像素对比

```bash
cd scripts/frame-compare && npm i        # 首次：安装 pixelmatch + pngjs（独立依赖，不进主 package.json）
cd ../..
node scripts/frame-compare/compare.cjs data/still-test/frame-3990.png data/still-test/pf-3990.png
```

- Renderer PNG（1920×1080）先 box-sample 缩放到 Player 截图尺寸，再 pixelmatch
- 输出 diff 像素比例；>5% 以非零码退出（M1 实测 4 帧均 <1%）
