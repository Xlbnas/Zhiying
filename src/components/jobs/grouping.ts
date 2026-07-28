/**
 * Jobs 页按项目分组收纳的纯逻辑（M5；与组件分离便于自动测试）。
 * 规则：
 * - 三类任务（LLM 生成 / TTS 音频 / 渲染）按 projectId 归入同一项目组；
 * - 组排序：有进行中任务的组优先，其余按最近入队时间倒序；
 * - 组头摘要：各类型计数 + 进行中任务的步骤级进度（render progress_detail）。
 */

export interface RenderJobItem {
  id: string;
  projectId: string | null;
  kind: string | null;
  status: string | null;
  progress: number;
  progressDetail: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface LlmJobItem {
  id: string;
  projectId: string;
  stage: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
}

export interface TtsJobItem {
  id: string;
  projectId: string;
  unitId: string;
  provider: string;
  voice: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  durationMs: number | null;
  queuedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ProjectJobGroup {
  projectId: string;
  title: string;
  llmJobs: LlmJobItem[];
  ttsJobs: TtsJobItem[];
  renderJobs: RenderJobItem[];
  /** queued/running 任务总数（三类合计）。 */
  activeCount: number;
  /** 组头展示的进行中摘要（优先渲染任务步骤明细）。 */
  activeSummary: string | null;
  latestQueuedAt: string;
}

const ACTIVE_STATUSES = new Set(['queued', 'running']);

function isActive(status: string | null): boolean {
  return status !== null && ACTIVE_STATUSES.has(status);
}

export function groupJobsByProject(input: {
  llmJobs: LlmJobItem[];
  ttsJobs: TtsJobItem[];
  renderJobs: RenderJobItem[];
  projects: Array<{id: string; title: string}>;
  /** 渲染进度摘要函数（由调用方注入，避免 UI 层依赖 DB JSON 格式）。 */
  summarizeRender: (job: RenderJobItem) => string;
}): ProjectJobGroup[] {
  const titleOf = new Map(input.projects.map((p) => [p.id, p.title]));
  const groups = new Map<string, ProjectJobGroup>();

  const groupFor = (projectId: string): ProjectJobGroup => {
    let g = groups.get(projectId);
    if (!g) {
      g = {
        projectId,
        title: titleOf.get(projectId) ?? '未知项目',
        llmJobs: [],
        ttsJobs: [],
        renderJobs: [],
        activeCount: 0,
        activeSummary: null,
        latestQueuedAt: '',
      };
      groups.set(projectId, g);
    }
    return g;
  };

  for (const job of input.llmJobs) {
    const g = groupFor(job.projectId);
    g.llmJobs.push(job);
    if (isActive(job.status)) g.activeCount += 1;
    if ((job.queuedAt ?? '') > g.latestQueuedAt) g.latestQueuedAt = job.queuedAt ?? '';
  }
  for (const job of input.ttsJobs) {
    const g = groupFor(job.projectId);
    g.ttsJobs.push(job);
    if (isActive(job.status)) g.activeCount += 1;
    if ((job.queuedAt ?? '') > g.latestQueuedAt) g.latestQueuedAt = job.queuedAt ?? '';
  }
  for (const job of input.renderJobs) {
    if (!job.projectId) continue;
    const g = groupFor(job.projectId);
    g.renderJobs.push(job);
    if (isActive(job.status)) {
      g.activeCount += 1;
      // 组头摘要优先取最近一个活跃渲染任务的步骤明细
      if (job.status === 'running' || g.activeSummary === null) {
        g.activeSummary = `渲染：${input.summarizeRender(job)}`;
      }
    }
    if ((job.queuedAt ?? '') > g.latestQueuedAt) g.latestQueuedAt = job.queuedAt ?? '';
  }

  // 组内兜底：有活跃 LLM/TTS 但无渲染摘要时给出简单说明
  for (const g of groups.values()) {
    if (g.activeCount > 0 && g.activeSummary === null) {
      const llm = g.llmJobs.find((j) => isActive(j.status));
      if (llm) {
        g.activeSummary = '生成任务进行中';
      } else if (g.ttsJobs.some((j) => isActive(j.status))) {
        g.activeSummary = '配音任务进行中';
      }
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    return b.latestQueuedAt.localeCompare(a.latestQueuedAt);
  });
}
