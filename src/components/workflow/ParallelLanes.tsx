'use client';

import type {ResourceClass} from '@/lib/workflow/resource-classes';
import {RESOURCE_CLASS_LABELS} from '@/lib/workflow/resource-classes';
import {
  LANE_LABELS,
  type WorkflowLane,
  type WorkflowNodeState,
  type WorkflowNodeStatus,
} from '@/lib/workflow/dag-shared';
import type {ActivityRunningJob} from './shared';

/**
 * 双泳道并行视图（M7 工作流 DAG）。
 *
 * script_v2 之后的两条独立分支并排呈现：
 * - 视觉规划（API）：旁白节拍 → 视觉拆解 → 镜头清单 → 场景数据
 * - 旁白与音频（TTS/GPU）：旁白计划 → 配音 → Audio Manifest → Subtitle
 * 下方接素材 / 汇合 / 渲染区。每节点显示依赖状态、资源类别标签与
 * queued/running/waiting_resource/succeeded/blocked 状态；
 * 两项以上并行运行时给出「互不占用同一资源」说明。
 * 纯展示组件：数据全部来自 WorkflowWorkspace 顶层 /activity 轮询，零自动 POST。
 */

const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  locked: '未解锁',
  ready: '可启动',
  running: '运行中',
  done: '已完成',
  blocked_waiting_resource: '等待资源',
  failed: '失败',
};

/** 节点状态 → 状态色修饰类（复用全站 --status-* 色系）。 */
const NODE_STATUS_TONE: Record<WorkflowNodeStatus, string> = {
  locked: 'queued',
  ready: 'queued',
  running: 'running',
  done: 'succeeded',
  blocked_waiting_resource: 'cancelled',
  failed: 'failed',
};

const LANE_ORDER: WorkflowLane[] = ['visual', 'audio'];
const CONVERGENCE_LANES: WorkflowLane[] = ['assets', 'convergence'];

function unmetDependencies(
  node: WorkflowNodeState,
  statusById: Map<string, WorkflowNodeState>,
): string[] {
  return node.dependencies
    .filter((dep) => statusById.get(dep)?.status !== 'done')
    .map((dep) => statusById.get(dep)?.label ?? dep);
}

function NodeChip({
  node,
  statusById,
}: {
  node: WorkflowNodeState;
  statusById: Map<string, WorkflowNodeState>;
}) {
  const unmet =
    node.status === 'locked' ? unmetDependencies(node, statusById) : [];
  return (
    <li className={`lane-node lane-node--${NODE_STATUS_TONE[node.status]}`}>
      <div className="lane-node-top">
        <span className="lane-node-label">{node.label}</span>
        <span className={`lane-node-status lane-node-status--${NODE_STATUS_TONE[node.status]}`}>
          {NODE_STATUS_LABELS[node.status]}
        </span>
      </div>
      <div className="lane-node-meta">
        <span className="lane-node-resource mono">{RESOURCE_CLASS_LABELS[node.resourceClass]}</span>
        {node.detail ? <span className="lane-node-detail">{node.detail}</span> : null}
        {unmet.length > 0 ? (
          <span className="lane-node-detail">依赖未完成：{unmet.join('、')}</span>
        ) : null}
      </div>
    </li>
  );
}

export function ParallelLanes({
  nodes,
  runningJobs,
}: {
  nodes: WorkflowNodeState[];
  runningJobs: ActivityRunningJob[];
}) {
  const statusById = new Map(nodes.map((n) => [n.id, n]));
  const runningNodes = nodes.filter((n) => n.status === 'running');
  const runningClasses = new Set<ResourceClass>(runningNodes.map((n) => n.resourceClass));

  return (
    <section className="lane-board" aria-label="并行工作流泳道">
      <div className="lane-grid">
        {LANE_ORDER.map((lane) => (
          <div key={lane} className={`lane lane--${lane}`}>
            <h3 className="lane-title">{LANE_LABELS[lane]}</h3>
            <ol className="lane-nodes">
              {nodes
                .filter((n) => n.lane === lane)
                .map((n) => (
                  <NodeChip key={n.id} node={n} statusById={statusById} />
                ))}
            </ol>
          </div>
        ))}
      </div>

      <div className="lane-convergence">
        {CONVERGENCE_LANES.map((lane) =>
          nodes
            .filter((n) => n.lane === lane)
            .map((n) => (
              <div key={n.id} className="lane-convergence-item">
                <span className="lane-convergence-group">{LANE_LABELS[n.lane]}</span>
                <ol className="lane-nodes">
                  <NodeChip node={n} statusById={statusById} />
                </ol>
              </div>
            )),
        )}
      </div>

      {runningNodes.length >= 2 && runningClasses.size > 1 ? (
        <p className="lane-note" role="status">
          {runningNodes.length} 项正在并行执行，互不占用同一资源（
          {runningJobs.length > 0 ? `${runningJobs.length} 个任务在队列中活跃` : '资源类别互不冲突'}
          ）
        </p>
      ) : null}
    </section>
  );
}
