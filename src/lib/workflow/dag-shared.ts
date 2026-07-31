import {WORKFLOW_STAGES, type WorkflowStage} from './types';
import type {ResourceClass} from './resource-classes';

/**
 * 工作流 DAG 纯图部分（M7）：节点注册表 + 依赖边 + reachability + 纯函数。
 *
 * 本模块零 DB/服务端依赖（type-only import），可被浏览器端组件安全引用；
 * 服务端 readiness 计算（computeWorkflowReadiness）在 ./dag.ts，
 * 并从那里 re-export 本模块全部内容（对外 API 面不变）。
 *
 * 失效传播边界（与后端现状一致，勿扩大）：
 * 视觉支（narration_beat_map…scenes）与音频支（narration_plan…subtitle_timing）
 * 在 script_v2 之后互为独立分支——视觉支改动不会 stale 音频支，反之亦然；
 * 唯一汇合点是 timing_reconciliation（真实下游集合见 downstreamOf）。
 */

// ---------- 节点注册表 ----------

export type WorkflowLane = 'foundation' | 'visual' | 'audio' | 'assets' | 'convergence';

export type WorkflowNodeStatus =
  | 'locked' // 依赖未满足（不可启动）
  | 'ready' // 依赖已满足，可启动
  | 'running' // 正在执行（含排队中的已触发任务）
  | 'done' // 已完成
  | 'blocked_waiting_resource' // ready 但资源被占（如 GPU 互斥组）
  | 'failed'; // 最近执行失败

export interface WorkflowNodeDef {
  id: string;
  /** 中文 label（UI 直显；id 即 labelKey）。 */
  label: string;
  lane: WorkflowLane;
  resourceClass: ResourceClass;
  dependencies: string[];
  /** 纯系统节点（确定性编译/finalize，无 LLM/GPU 外部调用）。 */
  automatic: boolean;
}

export interface WorkflowNodeState extends WorkflowNodeDef {
  status: WorkflowNodeStatus;
  /** 状态说明（如 waiting_resource 的占用方、failed 的错误码）。 */
  detail: string | null;
}

/** foundation stage 中文名（与 components/workflow/shared.ts STAGE_NAMES 对齐）。 */
const STAGE_LABELS: Record<WorkflowStage, string> = {
  project_definition: '选题定义',
  research: '研究',
  evidence: '证据',
  argument_tree: '论证树',
  script_v1: '脚本 V1',
  script_v2: '脚本 V2',
  narration_beat_map: '旁白节拍',
  visual_breakdown: '视觉拆解',
  shot_list: '镜头清单',
  scenes: '场景数据',
};

/** script_v2 及之前为 foundation 泳道；之后 4 个 stage 即视觉支。 */
const VISUAL_STAGES: ReadonlySet<string> = new Set([
  'narration_beat_map',
  'visual_breakdown',
  'shot_list',
  'scenes',
]);

function foundationNodeDefs(): WorkflowNodeDef[] {
  return WORKFLOW_STAGES.map((stage, i) => ({
    id: stage,
    label: STAGE_LABELS[stage],
    lane: VISUAL_STAGES.has(stage) ? 'visual' : 'foundation',
    resourceClass: 'llm_api',
    dependencies: i === 0 ? [] : [WORKFLOW_STAGES[i - 1]!],
    // LLM 生成节点：需用户触发/锁定，非纯系统节点
    automatic: false,
  }));
}

export const WORKFLOW_NODES: readonly WorkflowNodeDef[] = [
  ...foundationNodeDefs(),
  {
    id: 'narration_plan',
    label: '旁白计划',
    lane: 'audio',
    resourceClass: 'cpu_compile',
    dependencies: ['script_v2'],
    automatic: true,
  },
  {
    id: 'narration_tts',
    label: '配音',
    lane: 'audio',
    resourceClass: 'tts_gpu',
    dependencies: ['narration_plan'],
    automatic: false,
  },
  {
    id: 'narration_audio_manifest',
    label: 'Audio Manifest',
    lane: 'audio',
    resourceClass: 'cpu_compile',
    dependencies: ['narration_tts'],
    automatic: true,
  },
  {
    id: 'subtitle_timing',
    label: 'Subtitle',
    lane: 'audio',
    resourceClass: 'cpu_compile',
    dependencies: ['narration_audio_manifest'],
    automatic: true,
  },
  {
    id: 'assets',
    label: '视觉素材',
    lane: 'assets',
    resourceClass: 'network_io',
    dependencies: ['scenes'],
    automatic: false,
  },
  {
    id: 'timing_reconciliation',
    label: '时间轴对齐',
    lane: 'convergence',
    resourceClass: 'cpu_compile',
    dependencies: ['scenes', 'narration_audio_manifest', 'subtitle_timing'],
    automatic: true,
  },
  {
    id: 'render',
    label: '渲染（Preview / Final）',
    lane: 'convergence',
    resourceClass: 'render_gpu',
    dependencies: ['timing_reconciliation', 'assets'],
    automatic: false,
  },
];

const NODE_BY_ID = new Map(WORKFLOW_NODES.map((n) => [n.id, n]));

export function getNodeDef(nodeId: string): WorkflowNodeDef | undefined {
  return NODE_BY_ID.get(nodeId);
}

export const LANE_LABELS: Record<WorkflowLane, string> = {
  foundation: '基础链路',
  visual: '视觉规划（API）',
  audio: '旁白与音频（TTS/GPU）',
  assets: '视觉素材',
  convergence: '汇合与渲染',
};

// ---------- 失效传播（静态图 reachability） ----------

const DOWNSTREAM_ADJ = ((): Map<string, string[]> => {
  const adj = new Map<string, string[]>();
  for (const node of WORKFLOW_NODES) {
    for (const dep of node.dependencies) {
      const list = adj.get(dep) ?? [];
      list.push(node.id);
      adj.set(dep, list);
    }
  }
  return adj;
})();

/**
 * 真实下游集合（BFS，纯函数，按注册表顺序返回）。
 * downstreamOf('visual_breakdown') 不含音频节点；downstreamOf('narration_plan')
 * 不含视觉节点；downstreamOf('script_v2') 含两条分支。视觉支改动不 stale 音频支。
 */
export function downstreamOf(nodeId: string): string[] {
  if (!NODE_BY_ID.has(nodeId)) {
    throw new Error(`unknown workflow node: ${nodeId}`);
  }
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of DOWNSTREAM_ADJ.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const order = new Map(WORKFLOW_NODES.map((n, i) => [n.id, i]));
  return [...seen].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

/** reachability = downstreamOf（语义同义，供调度/失效传播调用方使用）。 */
export const reachability = downstreamOf;

// ---------- Project-stage 专属 DAG 辅助（M7.3A.2 authoritative DAG） ----------

const PROJECT_STAGE_SET = new Set<string>(WORKFLOW_STAGES);

/** 某 project_stage 的直接 DAG 依赖（仅返回同为 project_stages 的节点）。 */
export function directStageDependencies(stage: WorkflowStage): WorkflowStage[] {
  const node = NODE_BY_ID.get(stage);
  if (!node) return [];
  return node.dependencies.filter((d) => PROJECT_STAGE_SET.has(d)) as WorkflowStage[];
}

/** 某 project_stage 的 DAG 可达下游（仅返回同为 project_stages 的节点）。 */
export function downstreamStageNodes(stage: WorkflowStage): WorkflowStage[] {
  return downstreamOf(stage).filter((id) => PROJECT_STAGE_SET.has(id)) as WorkflowStage[];
}

/**
 * 锁定某节点后新解锁的 ready 节点（纯函数，UI handleLocked 与测试共用）。
 * 输入为锁定前的 readiness 快照；某节点此前为 locked 且其全部依赖
 * 为 done 或 justLockedId → 视为新 ready。返回注册表顺序的节点 id。
 */
export function computeNewlyReadyAfterLock(
  before: ReadonlyArray<Pick<WorkflowNodeState, 'id' | 'status' | 'dependencies'>>,
  justLockedId: string,
): string[] {
  const statusOf = new Map(before.map((n) => [n.id, n.status]));
  statusOf.set(justLockedId, 'done');
  const result: string[] = [];
  for (const node of WORKFLOW_NODES) {
    if (node.id === justLockedId) {
      continue;
    }
    const prevStatus = before.find((n) => n.id === node.id)?.status;
    if (prevStatus !== 'locked') {
      continue;
    }
    if (node.dependencies.every((d) => statusOf.get(d) === 'done')) {
      result.push(node.id);
    }
  }
  return result;
}
