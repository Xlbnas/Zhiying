'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {defaultGeneratePrompt} from '@/lib/assets/generate-prompt';

interface GeneratedCandidateData {
  assetId: string;
  publicPath: string;
  provider: string;
  prompt: string;
  createdAt: string;
}

interface BoundAssetData {
  id: string;
  local_path: string;
  description: string | null;
  source_type: string;
  license_status: string;
  attribution: string | null;
}

interface RequirementData {
  requirementId: string;
  index: number;
  requirement: {subject: string; query: string; policy: string; kind: string};
  status: string;
  friendlyStatus: string;
  boundAssetId: string | null;
  boundAsset: BoundAssetData | null;
  generatedCandidates: GeneratedCandidateData[];
  availableActions: string[];
  // M6.3.9：动作路由与用户态展示
  authenticity: string;
  recommendedAction: string | null;
  generateEligible: boolean;
  generateSecondary: boolean;
  generateDisabledReason: string | null;
  failureReason: string | null;
  statusHint: string;
  queriesTried: string[];
  // M7：超时/失败对账字段
  failurePhase: string | null;
  attemptId: string | null;
  providerRequestId: string | null;
  promptUsed: string | null;
  provider: string | null;
  model: string | null;
  elapsedMs: number | null;
  // M6.3.13：「改用 MG」语义闸门（authentic_required → 不渲染该动作）
  switchToMgEligible?: boolean;
  switchToMgDisabledReason?: string | null;
}

interface ResolutionData {
  sceneId: string;
  category: string;
  totalRequired: number;
  ready: number;
  overallStatus: string;
  requirements: RequirementData[];
  // M6.3.13：已「改用 MG」的 scene 的生效 override（徽标 + 改回入口）
  mgOverride?: {template: string} | null;
}

interface ResolverResponse {
  resolutions: ResolutionData[];
}

interface SummaryData {
  needAssets: number;
  readyRequirements: number;
  pendingAssets: number;
}

const SOURCE_LABELS: Record<string, string> = {
  generated: 'AI 生成',
  upload: '用户上传',
  archive: '档案素材',
  stock: '图库素材',
  local: '本地素材',
};

export function VisualAssetsPanel({projectId, scenesStageKey, onAssetsChanged}: {
  projectId: string;
  scenesStageKey: string;
  /** M6.3.10/M6.3.13：任何素材绑定变化（自动获取/搜索/AI 生成/候选绑定/上传替换/改用 MG）
      成功后通知外部刷新 Usage Summary 与 readiness 面板（无需 F5）。 */
  onAssetsChanged?: () => void;
}) {
  const [data, setData] = useState<ResolverResponse | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [expandedScene, setExpandedScene] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 上传目标：exact scene + requirement（上传与替换共用同一通道）
  const [uploadTarget, setUploadTarget] = useState<{sceneId: string; requirementId: string} | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  // 生成目标：exact requirement
  const [genTarget, setGenTarget] = useState<{sceneId: string; requirementId: string} | null>(null);
  const [genPrompt, setGenPrompt] = useState<string>('');
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null); // 搜索/绑定按钮 busy
  // M7.3A.2：同一次点击生命周期内复用同一个 requestId；显式「重新生成」才创建新 requestId
  const requestIdRef = useRef<Map<string, string>>(new Map());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // M6.3.13：「改用 MG」预览确认区（preview 不落库，确认才 switch）
  const [mgPreview, setMgPreview] = useState<{sceneId: string; template: string; templateProps: Record<string, unknown>} | null>(null);

  const load = useCallback(async () => {
    try {
      // resolve 响应已含 per-requirement 能力闸门（generateEligible / generateDisabledReason）
      const [r1, r2] = await Promise.all([
        fetch(`/api/projects/${projectId}/assets/resolve`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/assets`, {cache: 'no-store'}),
      ]);
      if (r1.ok) setData((await r1.json()) as ResolverResponse);
      if (r2.ok) {
        const d = await r2.json() as Record<string, unknown>;
        setSummary({
          needAssets: d.needAssets as number,
          readyRequirements: (d.readyRequirements as number) ?? 0,
          pendingAssets: d.pendingAssets as number,
        });
      }
      setError(null);
    } catch {
      setError('素材数据加载失败');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, scenesStageKey]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const errMsg = async (res: Response, fallback: string): Promise<string> =>
    ((await res.json().catch(() => null)) as {message?: string})?.message ?? `${fallback}（HTTP ${res.status}）`;

  const acquireAll = useCallback(async () => {
    setAcquiring(true); setResult(null); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/resolve`, {method: 'POST'});
      if (!res.ok) throw new Error(await errMsg(res, '获取失败'));
      const r = await res.json() as {acquired: number; reused: number; failed: number; results?: Array<{status: string}>};
      // M6.3.9：全局 summary 区分结果构成（成功 / 未找到 / 下载失败 / 其他）
      let noResult = 0; let downloadFailed = 0; let other = 0;
      for (const x of r.results ?? []) {
        if (x.status === 'no_result') noResult++;
        else if (x.status === 'download_failed') downloadFailed++;
        else if (x.status !== 'acquired' && x.status !== 'bound') other++;
      }
      setResult(
        `自动准备完成：成功 ${r.acquired}` +
        (noResult ? ` · 未找到 ${noResult}` : '') +
        (downloadFailed ? ` · 下载失败 ${downloadFailed}` : '') +
        (other ? ` · 其他失败 ${other}` : ''),
      );
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取失败');
    } finally { setAcquiring(false); }
  }, [projectId, load, onAssetsChanged]);

  const searchOne = useCallback(async (sceneId: string, requirementId: string) => {
    const key = `${sceneId}:${requirementId}:search`;
    setBusyKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/resolve`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId, requirementId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '搜索失败'));
      const r = await res.json() as {status: string; reason?: string};
      setResult(r.status === 'acquired' ? '已找到并绑定素材' : (r.reason ?? '未找到合适素材'));
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally { setBusyKey(null); }
  }, [projectId, load, onAssetsChanged]);

  const doGenerate = useCallback(async () => {
    if (!genTarget || !genPrompt.trim()) return;
    const key = `${genTarget.sceneId}:${genTarget.requirementId}:generate`;
    setGeneratingKey(key); setError(null); setResult(null);

    // M7.3A.2：同一次点击生命周期复用 requestId；显式重新生成（重新打开编辑器）才新 requestId
    const reqKey = `${genTarget.sceneId}:${genTarget.requirementId}`;
    let requestId = requestIdRef.current.get(reqKey);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requestIdRef.current.set(reqKey, requestId);
    }

    try {
      const res = await fetch(`/api/projects/${projectId}/assets/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sceneId: genTarget.sceneId,
          requirementId: genTarget.requirementId,
          prompt: genPrompt,
          requestId,
        }),
      });
      if (!res.ok) throw new Error(await errMsg(res, '生成失败'));
      const body = (await res.json()) as {jobId: string; requestId: string; status: string; reused: boolean};
      setResult(
        body.reused
          ? '该素材生成任务已存在，继续等待结果…'
          : 'AI 生成任务已提交（候选）。确认效果后点击「使用这张」才会绑定。',
      );
      setGenTarget(null);
      setGenPrompt('');
      startPolling(genTarget.sceneId, genTarget.requirementId, body.requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally { setGeneratingKey(null); }
  }, [projectId, genTarget, genPrompt]);

  const startPolling = useCallback((sceneId: string, requirementId: string, requestId: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    let terminal = false;
    const tick = async () => {
      if (terminal) return;
      try {
        const res = await fetch(
          `/api/projects/${projectId}/assets/generate?sceneId=${sceneId}&requirementId=${requirementId}&requestId=${requestId}`,
          {cache: 'no-store'},
        );
        if (!res.ok) return;
        const json = (await res.json()) as {job: {status: string; resultAssetId: string | null; failurePhase: string | null} | null};
        if (!json.job) return;
        if (json.job.status === 'succeeded' && json.job.resultAssetId) {
          terminal = true;
          setResult('AI 生成完成，候选已可用。');
          await load();
          onAssetsChanged?.();
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        } else if (json.job.status === 'failed' || json.job.status === 'indeterminate') {
          terminal = true;
          setResult(`AI 生成结束：${json.job.status}${json.job.failurePhase ? `（${json.job.failurePhase}）` : ''}`);
          await load();
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      } catch {
        // ignore polling errors
      }
    };
    void tick();
    pollTimerRef.current = setInterval(() => void tick(), 2000);
  }, [projectId, load, onAssetsChanged]);

  const bindCandidate = useCallback(async (sceneId: string, requirementId: string, assetId: string) => {
    const key = `${sceneId}:${requirementId}:bind:${assetId}`;
    setBusyKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/generated/${assetId}/bind`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId, requirementId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '绑定失败'));
      setResult('已绑定该素材');
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '绑定失败');
    } finally { setBusyKey(null); }
  }, [projectId, load, onAssetsChanged]);

  const uploadForTarget = useCallback(async (file: File) => {
    if (!uploadTarget) return;
    const key = `${uploadTarget.sceneId}:${uploadTarget.requirementId}:upload`;
    setUploadingKey(key); setError(null); setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sceneId', uploadTarget.sceneId);
      form.append('requirementId', uploadTarget.requirementId);
      const res = await fetch(`/api/projects/${projectId}/assets/upload`, {method: 'POST', body: form});
      if (!res.ok) throw new Error(await errMsg(res, '上传失败'));
      const r = await res.json() as {replaced?: boolean};
      setResult(r.replaced ? '已替换该需求的素材（旧素材保留在素材库）' : '已上传并绑定素材');
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploadingKey(null);
      setUploadTarget(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [projectId, uploadTarget, load, onAssetsChanged]);

  // M6.3.13：改用 MG —— preview → inline 确认 → switch；成功走统一 invalidation
  const startMgSwitch = useCallback(async (sceneId: string) => {
    const key = `${sceneId}:mg-preview`;
    setBusyKey(key); setError(null); setResult(null); setMgPreview(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/mg-preview`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '无法构建 MG 预览'));
      setMgPreview((await res.json()) as {sceneId: string; template: string; templateProps: Record<string, unknown>});
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法构建 MG 预览');
    } finally { setBusyKey(null); }
  }, [projectId]);

  const confirmMgSwitch = useCallback(async () => {
    if (!mgPreview) return;
    const key = `${mgPreview.sceneId}:mg-switch`;
    setBusyKey(key); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/switch-to-mg`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(mgPreview),
      });
      if (!res.ok) throw new Error(await errMsg(res, '切换失败'));
      setResult(`场景 ${mgPreview.sceneId} 已改用 MG 模板（原素材绑定已停用并保留历史）`);
      setMgPreview(null);
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换失败');
    } finally { setBusyKey(null); }
  }, [projectId, mgPreview, load, onAssetsChanged]);

  const revertMg = useCallback(async (sceneId: string) => {
    const key = `${sceneId}:mg-revert`;
    setBusyKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/revert-mg`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '改回失败'));
      setResult(`场景 ${sceneId} 已改回素材画面。原素材绑定不会自动恢复，请重新准备素材。`);
      await load();
      onAssetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '改回失败');
    } finally { setBusyKey(null); }
  }, [projectId, load, onAssetsChanged]);

  if (!summary) return null;
  const needScenes = data?.resolutions.filter((s) => s.totalRequired > 0) ?? [];
  const mgScenes = data?.resolutions.filter((s) => s.mgOverride) ?? [];
  if (summary.needAssets === 0 && mgScenes.length === 0) return null;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="视觉素材">
      <div className="panel-head">
        <span className="panel-title">视觉素材</span>
        <div className="panel-head-actions">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadForTarget(f); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={acquiring}
            onClick={() => void acquireAll()}>
            {acquiring ? '获取中…' : '自动准备全部'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div> : null}

      <div style={{padding: '0 24px 20px'}}>
        {(() => {
          const unresolvedScenes = needScenes.filter((s) => s.ready < s.totalRequired).length;
          const unresolvedReqs = needScenes.reduce((acc, s) => acc + s.requirements.filter((r) => r.status !== 'ready').length, 0);
          const searchFailed = needScenes.reduce(
            (acc, s) => acc + s.requirements.filter((r) => r.status === 'no_result' || r.status === 'download_failed').length,
            0,
          );
          const genFailed = needScenes.reduce(
            (acc, s) => acc + s.requirements.filter((r) => r.status === 'generation_failed').length,
            0,
          );
          return (
            <div style={{display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap'}}>
              <span style={{fontSize: 14}}>未解决场景：<strong>{unresolvedScenes}</strong></span>
              <span style={{fontSize: 14}}>未解决需求：<strong>{unresolvedReqs}</strong></span>
              <span style={{fontSize: 14}}>已准备：<strong style={{color: summary.pendingAssets === 0 ? 'var(--success)' : 'var(--accent)'}}>{summary.readyRequirements}</strong> / {summary.needAssets}</span>
              {searchFailed > 0 ? <span style={{fontSize: 12, color: 'var(--danger)'}}>搜索失败：{searchFailed}</span> : null}
              {genFailed > 0 ? <span style={{fontSize: 12, color: 'var(--danger)'}}>AI 生成失败：{genFailed}</span> : null}
            </div>
          );
        })()}

        {result ? <div style={{fontSize: 12, color: 'var(--success)', marginBottom: 8}}>{result}</div> : null}

        {/* M6.3.13：改用 MG 确认区（模板名 + props 摘要预览，确认才落库） */}
        {mgPreview ? (
          <div style={{border: '1px solid var(--accent)', borderRadius: 10, padding: 12, marginBottom: 12, background: 'var(--surface-raised)'}}>
            <div style={{fontSize: 13, marginBottom: 6}}>
              将场景 <strong>{mgPreview.sceneId}</strong> 改用 MG 模板：<strong>{mgPreview.template}</strong>
            </div>
            <pre className="mono" style={{fontSize: 11, margin: '0 0 8px', padding: 8, borderRadius: 6, background: 'var(--surface)', overflow: 'auto', maxHeight: 160}}>
              {JSON.stringify(mgPreview.templateProps, null, 2)}
            </pre>
            <div style={{fontSize: 12, color: 'var(--muted)', marginBottom: 8}}>
              切换后该场景不再使用外部素材；原素材绑定会停用（保留历史），改回后需重新准备。
            </div>
            <div style={{display: 'flex', gap: 6}}>
              <button type="button" className="btn btn-sm btn-primary"
                disabled={busyKey === `${mgPreview.sceneId}:mg-switch`}
                onClick={() => void confirmMgSwitch()}>
                {busyKey === `${mgPreview.sceneId}:mg-switch` ? '切换中…' : '确认切换'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setMgPreview(null)}>取消</button>
            </div>
          </div>
        ) : null}

        {/* M6.3.13：已改用 MG 的 scene（徽标 + 改回素材入口） */}
        {mgScenes.length > 0 ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 8, marginBottom: needScenes.length > 0 ? 12 : 0}}>
            {mgScenes.map((s) => (
              <div key={s.sceneId} style={{display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', background: 'var(--surface-raised)'}}>
                <span className="badge" data-stage-state="locked">MG</span>
                <span style={{flex: 1, fontSize: 13}}>
                  <strong>{s.sceneId}</strong> · 已改用 MG 模板（{s.mgOverride?.template}），无需外部素材
                </span>
                <button type="button" className="btn btn-sm"
                  disabled={busyKey === `${s.sceneId}:mg-revert`}
                  title="改回后原素材绑定不会自动恢复，需要重新准备素材"
                  onClick={() => void revertMg(s.sceneId)}>
                  {busyKey === `${s.sceneId}:mg-revert` ? '改回中…' : '改回素材'}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {needScenes.length > 0 ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            {needScenes.map((s) => (
              <div key={s.sceneId} style={{border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden'}}>
                <div style={{display: 'flex', alignItems: 'center', padding: '10px 14px', cursor: 'pointer',
                  background: s.ready === s.totalRequired ? 'var(--success-bg)' : 'var(--surface-raised)',
                }} onClick={() => setExpandedScene(expandedScene === s.sceneId ? null : s.sceneId)}>
                  <span style={{flex: 1, fontSize: 13}}>
                    <strong>{s.sceneId}</strong>
                    {s.requirements[0] ? <> · {s.requirements[0].requirement.subject.slice(0, 40)}</> : null}
                  </span>
                  <span style={{fontSize: 12, color: s.ready === s.totalRequired ? 'var(--success)' : 'var(--accent)', fontWeight: 600}}>
                    {s.ready}/{s.totalRequired} 已准备
                  </span>
                  <span style={{marginLeft: 8, fontSize: 11, opacity: 0.6}}>{expandedScene === s.sceneId ? '▲' : '▼'}</span>
                </div>

                {expandedScene === s.sceneId ? (
                  <div style={{padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)'}}>
                    {s.requirements.map((req) => {
                      const reqKey = `${s.sceneId}:${req.requirementId}`;
                      const isReady = req.status === 'ready';
                      const isFailure = req.status === 'download_failed' || req.status === 'generation_failed';
                      const statusColor = isReady ? 'var(--success)' : isFailure ? 'var(--danger)' : 'var(--accent)';
                      // M6.3.9：推荐动作主按钮单独一行；其余进「其他方式」行（select_candidate 由候选区块承担）
                      const buttonActions = req.availableActions.filter((a) => a !== 'select_candidate');
                      const primaryAction = req.recommendedAction && buttonActions.includes(req.recommendedAction)
                        ? req.recommendedAction
                        : null;
                      const secondaryActions = primaryAction ? buttonActions.filter((a) => a !== primaryAction) : buttonActions;
                      // 语义允许但 provider 不可用 → 展示真实 disabled 按钮（authentic_required 则不渲染 generate）
                      const showDisabledGenerate = !req.availableActions.includes('generate')
                        && req.generateEligible && !!req.generateDisabledReason;
                      const labelFor = (action: string): string => {
                        switch (action) {
                          case 'search': return req.status === 'pending' ? '搜索素材' : '重新搜索';
                          case 'retry_download': return '重新下载';
                          case 'generate': return req.generateSecondary ? 'AI生成替代' : 'AI 生成';
                          case 'upload': return '上传图片';
                          case 'replace': return '替换素材';
                          case 'switch_to_mg': return '改用 MG';
                          default: return action;
                        }
                      };
                      const renderBtn = (action: string, isPrimary: boolean) => {
                        const cls = isPrimary ? 'btn btn-sm btn-primary' : 'btn btn-sm';
                        if (action === 'switch_to_mg') {
                          // M6.3.13：resolver 不暴露该动作 = 语义禁止（authentic_required）；
                          // 暴露但被标记 ineligible 时展示真实 disabled 按钮 + 原因
                          const eligible = req.switchToMgEligible !== false;
                          const busy = busyKey === `${s.sceneId}:mg-preview`;
                          return (
                            <button key={action} className={cls} disabled={!eligible || busy}
                              title={eligible ? '改用 MG 模板画面（不再使用外部素材）' : (req.switchToMgDisabledReason ?? '该镜头不能改用 MG')}
                              onClick={() => void startMgSwitch(s.sceneId)}>
                              {busy ? '构建中…' : labelFor(action)}
                            </button>
                          );
                        }
                        if (action === 'search' || action === 'retry_download') {
                          const busy = busyKey === `${reqKey}:search`;
                          return (
                            <button key={action} className={cls} disabled={busy}
                              onClick={() => void searchOne(s.sceneId, req.requirementId)}>
                              {busy ? '搜索中…' : labelFor(action)}
                            </button>
                          );
                        }
                        if (action === 'generate') {
                          return (
                            <button key={action} className={cls}
                              onClick={() => {
                                setGenTarget({sceneId: s.sceneId, requirementId: req.requirementId});
                                setGenPrompt(defaultGeneratePrompt(req.requirement));
                              }}>
                              {labelFor(action)}
                            </button>
                          );
                        }
                        if (action === 'upload' || action === 'replace') {
                          const busy = uploadingKey === `${reqKey}:upload`;
                          return (
                            <button key={action} className={cls} disabled={busy}
                              onClick={() => { setUploadTarget({sceneId: s.sceneId, requirementId: req.requirementId}); fileRef.current?.click(); }}>
                              {busy ? '上传中…' : labelFor(action)}
                            </button>
                          );
                        }
                        return null;
                      };
                      const actualPrompt = req.promptUsed ?? req.requirement.query;
                      return (
                        <div key={req.requirementId} style={{marginBottom: 14, paddingBottom: 12, borderBottom: '1px dashed var(--border)'}}>
                          <div style={{display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap'}}>
                            <span style={{fontSize: 12, fontWeight: 600}}>需求 {req.index + 1}</span>
                            <span className="mono" style={{fontSize: 11, color: 'var(--muted)'}}>{req.requirementId}</span>
                            <span style={{fontSize: 11, color: 'var(--muted)'}}>policy={req.requirement.policy} · authenticity={req.authenticity}</span>
                            <span style={{fontSize: 12, fontWeight: 600, color: statusColor}}>
                              {isReady ? '✓ ' : ''}{req.friendlyStatus}
                            </span>
                            {req.recommendedAction ? (
                              <span style={{fontSize: 11, color: 'var(--accent)'}}>推荐：{req.recommendedAction}</span>
                            ) : null}
                          </div>

                          {/* 完整 query / prompt 必须在 requirement 卡片内可见 */}
                          <div style={{fontSize: 12, marginBottom: 6, padding: 8, borderRadius: 6, background: 'var(--surface-raised)', lineHeight: 1.5}}>
                            <span style={{color: 'var(--muted)'}}>{req.promptUsed ? '生成提示词：' : '搜索 query：'}</span>
                            <span>{actualPrompt}</span>
                          </div>

                          {/* 用户态说明：发生了什么 / 为什么 / 建议下一步（无需展开技术详情） */}
                          {req.statusHint ? (
                            <div style={{fontSize: 12, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.5}}>
                              {req.statusHint}
                            </div>
                          ) : null}

                          {/* 已绑定素材（exact binding） */}
                          {req.boundAsset ? (
                            <div style={{display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6}}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`/${req.boundAsset.local_path}`} alt={req.boundAsset.description ?? req.requirement.subject}
                                style={{width: 96, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)'}} />
                              <div style={{fontSize: 11, color: 'var(--muted)'}}>
                                <div>{SOURCE_LABELS[req.boundAsset.source_type] ?? req.boundAsset.source_type}
                                  {req.boundAsset.source_type === 'upload' ? '（版权由用户负责，系统未独立审核）' : ''}
                                  {req.boundAsset.source_type === 'generated' ? '（AI 生成素材）' : ''}
                                </div>
                                {req.boundAsset.attribution ? <div style={{opacity: 0.8}}>{req.boundAsset.attribution}</div> : null}
                              </div>
                            </div>
                          ) : null}

                          {/* 推荐动作（主按钮单独一行，窄屏 flex-wrap 自然折行） */}
                          {primaryAction ? (
                            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6}}>
                              {renderBtn(primaryAction, true)}
                            </div>
                          ) : null}

                          {/* 其他方式（全部针对 exact requirement） */}
                          {secondaryActions.length > 0 || showDisabledGenerate ? (
                            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
                              {primaryAction ? <span style={{fontSize: 11, color: 'var(--muted)'}}>其他方式：</span> : null}
                              {secondaryActions.map((a) => renderBtn(a, false))}
                              {showDisabledGenerate ? (
                                <button className="btn btn-sm" disabled title={req.generateDisabledReason ?? 'AI 生成暂不可用'}>
                                  AI 生成（暂不可用）
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {/* AI 生成 prompt 编辑器（针对 exact requirement） */}
                          {genTarget?.requirementId === req.requirementId ? (
                            <div style={{display: 'flex', gap: 6, flexDirection: 'column', width: '100%', marginTop: 6}}>
                              <textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)}
                                placeholder="描述你想要的画面..." rows={2}
                                style={{fontSize: 12, padding: 6, borderRadius: 6, border: '1px solid var(--border)', resize: 'vertical'}} />
                              <div style={{display: 'flex', gap: 6}}>
                                <button className="btn btn-sm btn-primary" disabled={generatingKey === `${reqKey}:generate` || !genPrompt.trim()}
                                  onClick={() => void doGenerate()}>
                                  {generatingKey === `${reqKey}:generate` ? '生成中…' : '开始生成'}
                                </button>
                                <button className="btn btn-sm" onClick={() => { setGenTarget(null); setGenPrompt(''); }}>取消</button>
                              </div>
                            </div>
                          ) : null}

                          {/* 未绑定 AI 生成候选（candidate-first：显式「使用这张」才绑定） */}
                          {req.generatedCandidates.length > 0 ? (
                            <div style={{marginTop: 8}}>
                              <div style={{fontSize: 11, color: 'var(--muted)', marginBottom: 4}}>
                                AI 生成候选（未绑定，不影响就绪状态）：
                              </div>
                              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                                {req.generatedCandidates.map((c) => (
                                  <div key={c.assetId} style={{border: '1px solid var(--border)', borderRadius: 8, padding: 6, background: 'var(--surface-raised)'}}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={`/${c.publicPath}`} alt={c.prompt.slice(0, 60)}
                                      style={{width: 128, height: 72, objectFit: 'cover', borderRadius: 4, display: 'block'}} />
                                    <div style={{fontSize: 10, color: 'var(--muted)', marginTop: 4, maxWidth: 128}}>
                                      AI 生成 · {c.provider}
                                    </div>
                                    <button className="btn btn-sm btn-primary" style={{marginTop: 4}}
                                      disabled={busyKey === `${reqKey}:bind:${c.assetId}`}
                                      onClick={() => void bindCandidate(s.sceneId, req.requirementId, c.assetId)}>
                                      {busyKey === `${reqKey}:bind:${c.assetId}` ? '绑定中…' : '使用这张'}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {/* 失败详情：直接显示在 requirement 框内 */}
                          {req.status === 'generation_failed' ? (
                            <div style={{fontSize: 11, color: 'var(--danger)', marginBottom: 6, lineHeight: 1.5}}>
                              <div><strong>失败阶段：</strong>{req.failurePhase ?? 'unknown'}</div>
                              <div><strong>原因：</strong>{req.failureReason ?? '—'}</div>
                              {req.elapsedMs !== null ? <div><strong>耗时：</strong>{(req.elapsedMs / 1000).toFixed(1)}s</div> : null}
                              {req.attemptId ? <div><strong>attemptId：</strong><span className="mono">{req.attemptId}</span></div> : null}
                              {req.providerRequestId ? <div><strong>providerRequestId：</strong><span className="mono">{req.providerRequestId}</span></div> : null}
                              {req.provider ? <div><strong>provider/model：</strong>{req.provider}/{req.model ?? '—'}</div> : null}
                            </div>
                          ) : null}

                          <details style={{marginTop: 6}}>
                            <summary style={{cursor: 'pointer', fontSize: 11, opacity: 0.6}}>技术详情</summary>
                            <div style={{fontSize: 10, opacity: 0.5, marginTop: 4}}>
                              sceneId={s.sceneId} requirementId={req.requirementId} policy={req.requirement.policy} authenticity={req.authenticity}<br />
                              status={req.status} recommended={req.recommendedAction ?? '—'}<br />
                              queriesTried=[{req.queriesTried.join(', ')}]
                              {req.generateDisabledReason ? <> generateDisabled=&quot;{req.generateDisabledReason}&quot;</> : null}
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
