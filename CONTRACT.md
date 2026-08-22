# 知影 M1 开发契约（CONTRACT）

> 本文件是 M1 并行开发的**唯一接口基准**。所有实现必须与本契约一致。
> 上级目录《视频生成器_架构设计文档.md》(v0.2.1) 因文件不可取得、且不在当前仓库或 Git history 中，自 2026-08-22 起废止其作为当前架构 Source of Truth 的地位。迁移期间以当前源码/tests、已验证 Feiniu production facts、`docs/skill_migration/04_CONTRACT_FREEZE.md` 与 `docs/skill_migration/03_ARCHITECTURE_REVIEW.md` 为准；历史引用仅作记录。
> M1 红线：**不接 LLM / DeepSeek / TTS / Sources**，只做渲染闭环。

## 1. 目录布局（各 agent 只动自己的范围）

```
zhiying/
├── .agents/skills/            # 已完成，任何人不得修改
├── src/
│   ├── lib/
│   │   ├── scene-schema.ts    # 【地基已提供】zod schema + 类型，唯一数据真相
│   │   ├── db.ts              # 【Worker agent】SQLite 连接 + 建表 + PRAGMA
│   │   └── jobs.ts            # 【Worker agent】job 入队 / 原子 claim / heartbeat
│   ├── worker/
│   │   └── index.ts           # 【Worker agent】单调度器 + 渲染执行
│   ├── remotion/              # 【Template agent】从 04_Remotion/src 改造
│   │   ├── index.ts           # registerRoot 入口（供 @remotion/bundler）
│   │   ├── Root.tsx
│   │   └── ...（components/compositions/data/design/types/utils 原样复制）
│   ├── app/                   # 【API agent 只动 api/；UI agent 只动页面与组件】
│   │   ├── layout.tsx         # 【UI agent】
│   │   ├── page.tsx           # 【UI agent】项目列表
│   │   ├── globals.css        # 【UI agent】设计 tokens
│   │   ├── project/[id]/page.tsx   # 【UI agent】Scene 列表 + Player
│   │   ├── jobs/page.tsx           # 【UI agent】任务队列
│   │   └── api/               # 【API agent】
│   │       ├── projects/route.ts
│   │       ├── projects/import/route.ts
│   │       ├── projects/[id]/route.ts
│   │       ├── projects/[id]/scenes/route.ts
│   │       ├── projects/[id]/render/route.ts
│   │       ├── jobs/route.ts
│   │       └── jobs/[id]/download/route.ts
│   └── components/            # 【UI agent】React 组件（含 Player 封装）
├── public/                    # 【Template agent】复制 04_Remotion/public 下 full/、pilot/
├── samples/
│   └── FullCutScenes.json     # 【Scripts agent】复制自 07_FullCut/
├── scripts/                   # 【Scripts agent】import + round-trip 校验
├── data/                      # 运行时生成（DB、bundle 缓存、渲染输出），gitignore
├── Dockerfile                 # 【Docker agent】
├── docker-compose.yml         # 【Docker agent】
├── .dockerignore              # 【Docker agent】
├── package.json               # 【地基已提供，禁止修改；缺依赖在交付报告中提出】
├── tsconfig.json              # 【地基已提供，禁止修改】
├── next.config.ts             # 【地基已提供，禁止修改】
├── .env.example               # 【Docker agent】
└── .gitignore                 # 【地基已提供】
```

## 2. 数据契约

唯一数据源定义在 `src/lib/scene-schema.ts`（已提供）：
- `FullCutData` = `{ project, chapterTiming, scenes }`，对应 samples/FullCutScenes.json
- `SubtitleCue` = `{ id, segmentId, chapter, text, start, end, position }`
- `ZhiyingFullCutProps` = `{ data: FullCutData; subtitles: SubtitleCue[]; audio: { narration: string | null } ; showSubtitles: boolean }`

### Composition 契约（Template agent 必须实现）

- Composition ID：**`ZhiyingFullCut`**，另有 `ZhiyingFullCutNoSubtitles`（showSubtitles=false）
- 组件签名：`({ data, subtitles, audio, showSubtitles }: ZhiyingFullCutProps) => JSX.Element`
- 必须提供 `calculateMetadata`，从 `props.data.project.durationInFrames / fps / width / height` 推导
- `defaultProps` 使用现有 `src/remotion/data/fullCutScenes.ts` + `fullCutSubtitles.json` 的数据（独立可预览）
- 渲染数据流：DB 里的 scenes JSON → props 传入；组件内**禁止再 import 硬编码场景数据**（defaultProps 除外）
- 旁白音频：`audio.narration` 为 staticFile 相对路径（如 `full/audio/xxx.wav`），null 则不挂 `<Audio>`
- 现有 FullCutV1.tsx 的视觉逻辑（SceneRenderer、章节标签、字幕轨等）**原样保留**，只改数据入口

## 3. 数据库契约（Worker agent 实现）

DB 文件：`data/zhiying.db`。连接时执行：
`PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON; synchronous=NORMAL;`

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,               -- nanoid/uuid
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rigorous',
  schema_version TEXT NOT NULL DEFAULT '1.0',
  template_version TEXT NOT NULL DEFAULT 'freud-mg-v1.0',
  composition_id TEXT NOT NULL DEFAULT 'ZhiyingFullCut',
  current_stage TEXT NOT NULL DEFAULT 'scenes',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                -- 'scenes' | 'subtitles' | 'render_output'
  version INTEGER NOT NULL DEFAULT 1,
  content_json TEXT,                 -- scenes/subtitles 等 JSON 文本
  file_path TEXT,                    -- 大文件（mp4）走路径
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'fullcut',   -- 'fullcut' | 'no-subtitles'
  status TEXT NOT NULL DEFAULT 'queued',  -- queued/running/succeeded/failed/cancelled
  progress REAL NOT NULL DEFAULT 0,       -- 0-100
  payload_json TEXT NOT NULL,             -- ZhiyingFullCutProps JSON
  output_path TEXT,
  error_code TEXT, error_message TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_jobs (   -- M2 用，M1 只建表不消费
  id TEXT PRIMARY KEY, project_id TEXT, stage TEXT,
  status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT,
  queued_at TEXT, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 2,
  progress REAL DEFAULT 0, error_code TEXT, error_message TEXT,
  cancel_requested INTEGER DEFAULT 0
);
```

导出两个模块：
- `src/lib/db.ts`：`getDb(): Database`（单例，自动建目录/建表/PRAGMA），数据目录解析顺序：`ZHIYING_DATA_DIR` → `./data`
- `src/lib/jobs.ts`：`enqueueRenderJob(projectId, kind, payload)`、`claimNextJob(workerId): Job | null`（**BEGIN IMMEDIATE 原子 claim**）、`heartbeat(jobId, progress)`、`completeJob(jobId, outputPath)`、`failJob(jobId, code, msg)`（未超 max_attempts 自动回 queued）、`recoverStaleJobs(timeoutMs)`、`requestCancel(jobId)`、`isCancelRequested(jobId)`

## 4. Worker 契约（Worker agent 实现）

`npm run worker` → `tsx src/worker/index.ts`：
1. 启动：`recoverStaleJobs(2min)` → 检查 `data/bundle-cache/{templateVersion}/` 无则 `bundle({entryPoint: src/remotion/index.ts})` 缓存
2. 单调度循环（每 2s）：`claimNextJob` → 有则执行，无则继续；**任何时刻只跑一个**
3. 渲染：`selectComposition({serveUrl: bundle, id, inputProps})` → `renderMedia({...})`
   - `onProgress` → `heartbeat(jobId, progress)`（也兼作 heartbeat，≤5s 一次）
   - 每轮检查 `isCancelRequested` → 取消则中止（renderMedia 支持 cancelSignal）
   - 输出：`data/projects/{projectId}/renders/{jobId}.mp4`，codec h264
     （M6.3.10：REMOTION_NVENC=true 且真实编码探测通过 → h264_nvenc + videoBitrate；
     否则 libx264 crf 18 回退并记录 fallbackReason；分辨率/帧率/封装不变）
4. 环境变量：`WORKER_ROLE=all`（预留，M1 只实现 all）、`ZHIYING_DATA_DIR`
5. 优雅退出：SIGTERM/SIGINT 时当前任务标记回 queued 后退出

## 5. API 契约（API agent 实现）

全部 Route Handler，`export const runtime = 'nodejs'`（better-sqlite3 需要）：

| 路由 | 方法 | 行为 | 返回 |
|---|---|---|---|
| /api/projects | GET | 项目列表（含每项目 job 统计） | `{projects: [...]}` |
| /api/projects/import | POST | body = FullCutScenes.json 原文；zod 校验（`fullCutDataSchema`）→ 创建 project + scenes artifact；同时尝试从 `public/full/fullCutSubtitles.json` 之外读入 payload 中的 subtitles 字段（如有） | `{project: {...}}`，校验失败 422 带 issues |
| /api/projects/[id] | GET | 项目详情 + artifact 版本信息 | `{project, artifacts}` |
| /api/projects/[id]/scenes | GET | 当前 scenes + subtitles + audio（供 Player） | `ZhiyingFullCutProps` JSON |
| /api/projects/[id]/render | POST | `{kind}` → 组装 payload（scenes artifact + subtitles + audio 路径）→ `enqueueRenderJob` | `{job}` |
| /api/jobs | GET | 全部 job，按 queued_at 倒序 | `{jobs: [...]}` |
| /api/jobs/[id]/download | GET | 流式返回 output_path 的 mp4（Content-Disposition attachment）；未完成 409 | mp4 |

**round-trip 无损要求**：import 存库的 scenes JSON 与源文件语义一致（scene 数、id、顺序、start/end、template、schemaVersion）。

## 6. UI 契约（UI agent 实现）

必须遵守 `.agents/skills/zhiying-ui-design/SKILL.md`（先读）。深色工作台基调，语义化 CSS tokens 定义在 globals.css（`--bg --surface --elevated --border --text-1 --text-2 --muted --accent --success --warning --danger`）。

- `/` 项目列表：编辑部气质，项目卡片含标题、场景数、时长、最近渲染状态；「导入项目」按钮（选择本地 FullCutScenes.json 上传 → POST /api/projects/import）
- `/project/[id]`：**左 Scene 列表 + 右 Player** 工作台布局
  - Player 用 `@remotion/player` 的 `<Player>`，component 从 `src/remotion/` 导入（**与渲染同一组件，同构原则**），inputProps 从 `/api/projects/[id]/scenes` 拉取
  - Scene 列表显示 ID / 章节 / 时长 / 模板 / 类型；M1 只读，不实现编辑
  - 「导出成片」「导出无字幕版」按钮 → POST render → 跳 /jobs
- `/jobs` 任务队列：状态 Badge（统一状态色）、进度条（2s 轮询 /api/jobs）、完成后下载按钮
- 顶部导航：知影 logo 文案 + 项目 / 任务 两个入口；中文界面
- 时间码、Scene ID 用等宽数字；1366/1440/1920 宽度正常

## 7. Docker 契约（Docker agent 实现）

- 基础 `node:22-bookworm`（M4-B 起；pnpm@11.9.0 依赖 node:sqlite 需 Node≥22，且开发机实证 v22。M1 原为 node:20-bookworm），按 Remotion 官方 Dockerfile 安装 Chrome Headless 依赖（libnss3 等）+ ffmpeg + fonts-noto-cjk
- corepack 启用 pnpm；`pnpm install --frozen-lockfile`；`pnpm build`（Next）+ 运行时 `npm run start` / `npm run worker`
- compose：`web`（3000 端口）+ `worker`（cpus: 4, mem_limit: 6g），共享 volume `./data:/app/data` + `./public:/app/public:ro`（资源大，不打进镜像）
- .dockerignore：data/、public/full、public/pilot、node_modules、.next、samples
- .env.example：ZHIYING_DATA_DIR、WORKER_ROLE、PORT

## 8. Scripts 契约（Scripts agent 实现）

- `samples/FullCutScenes.json`：从 `../07_FullCut/FullCutScenes.json` 复制
- `scripts/import-sample.mjs`：调本地 API（或直接走 db）导入 sample，打印 project id
- `scripts/verify-roundtrip.mjs`：导出 project scenes 与源文件逐字段对比（85 scenes：id/顺序/start/end/duration/template/category），全部一致输出 PASS，否则打印 diff 并非零退出

## 9. 全局规则

1. **不得修改** package.json / tsconfig.json / next.config.ts / .agents/** / CONTRACT.md / scene-schema.ts；缺依赖写进交付报告
2. remotion 与 @remotion/* 一律 `4.0.492` 精确版本（已在 package.json 锁好）
3. TypeScript 严格模式，零 any（除确实无法类型的边界，需注释说明）
4. 所有时间用 ISO 字符串（`new Date().toISOString()`）
5. ID 用 `crypto.randomUUID()`
6. 完成后各自验证 `npx tsc --noEmit` 自己负责的文件可通过（允许因他人文件未完成产生的 import 报错，但自己的代码逻辑必须完整）
