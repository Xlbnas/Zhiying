'use client';

import {useCallback, useEffect, useState} from 'react';
import {fmtDuration} from '@/lib/usage/format';

interface StageUsage {
  stage: string;
  costCny: number;
  tokens: number;
  cpuHours: number;
  gpuHours: number;
  wallHours: number;
}

interface ImageUsageSummary {
  calls: number;
  images: number;
  costCny: number;
  unknownBilling: number;
  authFailed: number;
  providers: string[];
  models: string[];
  backfilled: number;
}

interface UsageSummary {
  projectId: string;
  totalCostCny: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCpuHours: number;
  totalGpuHours: number;
  totalWallHours: number;
  byStage: StageUsage[];
  llmEvents: number;
  cpuEvents: number;
  gpuEvents: number;
  image: ImageUsageSummary;
  dataStartAt: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  project_definition: '选题定义',
  research: '研究',
  evidence: '证据',
  argument_tree: '论证树',
  script_v1: '脚本 V1',
  script_v2: '脚本 V2',
  narration_beat_map: '旁白节拍',
  visual_breakdown: '视觉拆解',
  shot_list: '镜头清单',
  scenes: '场景',
  narration: '旁白',
  assets: '素材',
  image_generation: '图像生成',
  render: '渲染',
  tts: '配音',
  other: '其他',
};

function fmtCny(cny: number): string {
  return `¥ ${cny.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`;
  return String(n);
}

export function UsageSummaryPanel({projectId, refreshKey}: {projectId: string; refreshKey?: number}) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/summary`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as UsageSummary);
      setError(null);
    } catch {
      setError('用量数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">加载用量数据…</div>;

  const hasAnyData =
    data.totalTokens > 0 ||
    data.totalCpuHours > 0 ||
    data.totalGpuHours > 0 ||
    data.totalWallHours > 0 ||
    data.image.calls > 0;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="用量总结">
      <div className="panel-head">
        <span className="panel-title">用量总结</span>
      </div>

      {!hasAnyData ? (
        <div className="stage-empty">
          <p className="empty-title">暂无用量数据</p>
          {data.dataStartAt ? (
            <p>从 {new Date(data.dataStartAt).toLocaleDateString('zh-CN')} 起开始统计</p>
          ) : (
            <p>项目尚未产生用量记录</p>
          )}
        </div>
      ) : (
        <div style={{padding: '0 24px 20px'}}>
          {/* 核心指标 */}
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, padding: '16px 0'}}>
            <MetricCard label="总费用" value={fmtCny(data.totalCostCny)} />
            <MetricCard label="Token" value={fmtTokens(data.totalTokens)}
              sub={`输入 ${fmtTokens(data.totalInputTokens)} · 输出 ${fmtTokens(data.totalOutputTokens)}`}
            />
            <MetricCard label="AI 图片" value={fmtCny(data.image.costCny)}
              sub={data.image.calls > 0 ? `${data.image.calls} 次生成 · ${data.image.images} 张图片` : '—'}
            />
            <MetricCard label="CPU" value={fmtDuration(data.totalCpuHours)}
              sub={data.cpuEvents > 0 ? `${data.cpuEvents} 个任务` : '—'}
            />
            <MetricCard label="GPU" value={fmtDuration(data.totalGpuHours)}
              sub={data.gpuEvents > 0 ? `${data.gpuEvents} 个任务` : '—'}
            />
            <MetricCard label="总耗时" value={fmtDuration(data.totalWallHours)} />
          </div>

          {data.dataStartAt ? (
            <div style={{fontSize: 12, color: 'var(--muted)', marginBottom: 16}}>
              从 {new Date(data.dataStartAt).toLocaleString('zh-CN')} 起开始统计
              {data.llmEvents > 0 ? ` · ${data.llmEvents} 次大模型调用` : ''}
              {data.image.calls > 0 ? ` · ${data.image.calls} 次图像生成` : ''}
              {' · '}
              费用根据配置单价估算，实际账单可能存在差异。
            </div>
          ) : null}

          {/* 分阶段明细 */}
          {data.byStage.length > 0 ? (
            <>
              <h4 style={{margin: '16px 0 8px', fontSize: 14, fontWeight: 600}}>分阶段明细</h4>
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', fontSize: 13, borderCollapse: 'collapse'}}>
                  <thead>
                    <tr style={{borderBottom: '1px solid var(--border)'}}>
                      <th style={{textAlign: 'left', padding: '6px 12px'}}>阶段</th>
                      <th style={{textAlign: 'right', padding: '6px 12px'}}>费用</th>
                      <th style={{textAlign: 'right', padding: '6px 12px'}}>Token</th>
                      <th style={{textAlign: 'right', padding: '6px 12px'}}>CPU</th>
                      <th style={{textAlign: 'right', padding: '6px 12px'}}>GPU</th>
                      <th style={{textAlign: 'right', padding: '6px 12px'}}>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStage.map((s) => (
                      <tr key={s.stage} style={{borderBottom: '1px solid var(--border)'}}>
                        <td style={{padding: '6px 12px'}}>{STAGE_LABELS[s.stage] ?? s.stage}</td>
                        <td style={{textAlign: 'right', padding: '6px 12px'}}>{s.costCny > 0 ? fmtCny(s.costCny) : '—'}</td>
                        <td style={{textAlign: 'right', padding: '6px 12px'}}>{s.tokens > 0 ? fmtTokens(s.tokens) : '—'}</td>
                        <td style={{textAlign: 'right', padding: '6px 12px'}}>{s.cpuHours > 0 ? fmtDuration(s.cpuHours) : '—'}</td>
                        <td style={{textAlign: 'right', padding: '6px 12px'}}>{s.gpuHours > 0 ? fmtDuration(s.gpuHours) : '—'}</td>
                        <td style={{textAlign: 'right', padding: '6px 12px'}}>{s.wallHours > 0 ? fmtDuration(s.wallHours) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          <details style={{marginTop: 16}}>
            <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
            <div className="mono" style={{marginTop: 8, fontSize: 11, lineHeight: 1.6}}>
              projectId: {data.projectId}<br />
              llm events: {data.llmEvents} · cpu events: {data.cpuEvents} · gpu events: {data.gpuEvents}<br />
              cache tokens: {fmtTokens(data.totalCacheTokens)}<br />
              data since: {data.dataStartAt ?? 'N/A'}<br />
              CPU = 容器 cgroup cpu.stat usage_usec delta 累计（worker 串行归属单个任务）<br />
              GPU = 真实走 NVENC 路径的渲染 attempt wall duration 累计，不按利用率加权<br />
              总耗时 = render/tts 任务 started_at→finished_at（不含 LLM API 等待）<br />
              {data.image.calls + data.image.unknownBilling + data.image.authFailed > 0 ? (
                <>
                  图像生成: {data.image.calls} 次成功计费 · {data.image.images} 张
                  {data.image.unknownBilling > 0 ? ` · ${data.image.unknownBilling} 次费用未知（未计入）` : ''}
                  {data.image.authFailed > 0 ? ` · ${data.image.authFailed} 次认证失败（¥0）` : ''}
                  {data.image.backfilled > 0 ? ` · ${data.image.backfilled} 次历史回填` : ''}<br />
                  provider: {data.image.providers.join(', ') || 'N/A'} · model: {data.image.models.join(', ') || 'N/A'}<br />
                  图像费用 = 每次 generation attempt × 写入时单价快照（configured_estimate，含未采用 candidate）<br />
                </>
              ) : null}
              部分历史用量不可追溯
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function MetricCard({label, value, sub}: {label: string; value: string; sub?: string}) {
  return (
    <div style={{
      padding: '16px', borderRadius: 12,
      background: 'var(--surface-raised)', border: '1px solid var(--border)',
    }}>
      <div style={{fontSize: 12, color: 'var(--muted)', marginBottom: 4}}>{label}</div>
      <div style={{fontSize: 22, fontWeight: 700}}>{value}</div>
      {sub ? <div style={{fontSize: 11, color: 'var(--muted)', marginTop: 4}}>{sub}</div> : null}
    </div>
  );
}
