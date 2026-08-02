'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {formatDateTime, formatDurationMs} from '@/components/format';

/**
 * /settings/voices — 声音库（TTS-A Voice Library 最小 UI）。
 *
 * 边界（设计文档：docs/TTS_A_VOICE_LIBRARY_DESIGN.md）：
 * - 仅管理 Voice Profile + 参考音频 revision；revision 创建后不可修改（immutable）。
 * - 此声音库尚未绑定任何项目；本页不做任何「绑定 / 设为默认 / 触发 TTS」操作。
 * - TTS-A 不生成旁白；suggestedLatestForDisplay 仅是显示建议，不是 selected/current/default。
 *
 * API 响应做了防御性归一化（asStr/asNum/asObj），字段缺口显示占位符而不报错。
 */

// ---------- 防御性归一化 ----------

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

interface ProfileItem {
  id: string;
  displayName: string;
  provider: string;
  description: string | null;
  status: 'active' | 'archived';
  createdAt: string | null;
}

interface RevisionItem {
  id: string;
  revisionNumber: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  canonicalAudioSha256: string | null;
  adapterCompatibilityKey: string | null;
  transcript: string | null;
  language: string | null;
  createdAt: string | null;
}

function normalizeProfile(raw: unknown): ProfileItem | null {
  const p = asObj(raw);
  if (!p) return null;
  const id = asStr(p.id);
  if (!id) return null;
  const status = asStr(p.status) === 'archived' ? 'archived' : 'active';
  return {
    id,
    displayName: asStr(p.displayName) ?? '未命名声音',
    provider: asStr(p.provider) ?? '—',
    description: asStr(p.description),
    status,
    createdAt: asStr(p.createdAt),
  };
}

function normalizeRevision(raw: unknown): RevisionItem | null {
  const r = asObj(raw);
  if (!r) return null;
  const id = asStr(r.id);
  if (!id) return null;
  return {
    id,
    revisionNumber: asNum(r.revisionNumber),
    durationMs: asNum(r.durationMs),
    sampleRate: asNum(r.sampleRate),
    channels: asNum(r.channels),
    codec: asStr(r.codec),
    canonicalAudioSha256: asStr(r.canonicalAudioSha256),
    adapterCompatibilityKey: asStr(r.adapterCompatibilityKey),
    transcript: asStr(r.transcript),
    language: asStr(r.language),
    createdAt: asStr(r.createdAt),
  };
}

/** 后端错误响应 {error: code, message?} → 可读文案（含 error code）。 */
function apiErrorText(json: unknown, status: number): string {
  const obj = asObj(json);
  const code = asStr(obj?.error);
  const message = asStr(obj?.message);
  if (code && message) return `[${code}] ${message}`;
  return message ?? code ?? `HTTP ${status}`;
}

// ---------- 创建 Profile 表单 ----------

function CreateProfileForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = displayName.trim().length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/voice-profiles', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          displayName: displayName.trim(),
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => null);
        throw new Error(apiErrorText(json, res.status));
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
      setBusy(false);
    }
  };

  return (
    <section className="new-project fade-in" aria-label="新建声音 Profile">
      <div className="form-grid">
        <div className="form-field full">
          <label className="form-label" htmlFor="vp-name">
            名称 *
          </label>
          <input
            id="vp-name"
            className="form-input"
            placeholder="例如：磁性男声 · 知识讲解"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-field full">
          <label className="form-label" htmlFor="vp-desc">
            描述（可选）
          </label>
          <input
            id="vp-desc"
            className="form-input"
            placeholder="用途、音色特点等备注"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="form-foot">
        <p className="form-hint">仅创建声音档案；创建后可在档案内上传参考音频。</p>
        <div style={{display: 'flex', gap: 8}}>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? '创建中…' : '创建 Profile'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------- 上传参考音频表单 ----------

function UploadRevisionForm({
  profileId,
  onUploaded,
}: {
  profileId: string;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit = requestId.trim().length > 0 && file !== null && !busy;

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('requestId', requestId.trim());
      form.append('audio', file);
      if (transcript.trim()) form.append('transcript', transcript.trim());
      if (language.trim()) form.append('language', language.trim());
      const res = await fetch(`/api/voice-profiles/${profileId}/revisions`, {
        method: 'POST',
        body: form,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(apiErrorText(json, res.status));
      }
      const reused = res.status === 200 || asStr(asObj(json)?.outcome) === 'reused';
      setNotice(
        reused
          ? '已复用现有 revision（相同 requestId 与音频内容，未创建新 revision）。'
          : '已创建新 revision。revision 创建后不可修改。',
      );
      // 成功后重置表单并生成新 requestId，避免误重发
      setRequestId(crypto.randomUUID());
      setFile(null);
      setTranscript('');
      setLanguage('');
      if (fileRef.current) fileRef.current.value = '';
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="voice-upload" aria-label="上传新参考音频">
      <span className="voice-section-title">上传新参考音频</span>
      <div className="form-grid">
        <div className="form-field">
          <label className="form-label" htmlFor={`vr-req-${profileId}`}>
            requestId（幂等键）*
          </label>
          <div style={{display: 'flex', gap: 6}}>
            <input
              id={`vr-req-${profileId}`}
              className="form-input mono"
              style={{flex: 1, minWidth: 0}}
              value={requestId}
              onChange={(e) => setRequestId(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRequestId(crypto.randomUUID())}
            >
              生成 UUID
            </button>
          </div>
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor={`vr-file-${profileId}`}>
            音频文件 *
          </label>
          <input
            id={`vr-file-${profileId}`}
            ref={fileRef}
            className="form-input"
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="form-field full">
          <label className="form-label" htmlFor={`vr-transcript-${profileId}`}>
            文本稿（可选）
          </label>
          <input
            id={`vr-transcript-${profileId}`}
            className="form-input"
            placeholder="参考音频对应的口播文本"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor={`vr-lang-${profileId}`}>
            语言（可选）
          </label>
          <input
            id={`vr-lang-${profileId}`}
            className="form-input"
            placeholder="例如 zh-CN"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          />
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="notice-banner">{notice}</div> : null}

      <div className="form-foot">
        <p className="form-hint">
          音频上限 25MB；服务端将统一转码为 canonical WAV，revision 创建后不可修改。
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? '上传中…' : '上传参考音频'}
        </button>
      </div>
    </section>
  );
}

// ---------- Profile 展开详情：suggested 提示 + revision 历史 + 上传 ----------

function ProfileDetail({profileId}: {profileId: string}) {
  const [revisions, setRevisions] = useState<RevisionItem[] | null>(null);
  const [suggested, setSuggested] = useState<RevisionItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [detailRes, revRes] = await Promise.all([
        fetch(`/api/voice-profiles/${profileId}`, {cache: 'no-store'}),
        fetch(`/api/voice-profiles/${profileId}/revisions`, {cache: 'no-store'}),
      ]);
      if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
      if (!revRes.ok) throw new Error(`HTTP ${revRes.status}`);
      const detail: unknown = await detailRes.json();
      const revJson: unknown = await revRes.json();
      const list = asObj(revJson)?.revisions;
      setRevisions(
        Array.isArray(list)
          ? list.map(normalizeRevision).filter((r): r is RevisionItem => r !== null)
          : [],
      );
      setSuggested(normalizeRevision(asObj(detail)?.suggestedLatestForDisplay));
      setError(null);
    } catch {
      setError('加载 revision 历史失败，请重试');
      setRevisions([]);
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="voice-detail">
      {suggested ? (
        <p className="voice-suggest">
          最新参考（仅显示建议）：r{suggested.revisionNumber ?? '—'} ·{' '}
          {formatDurationMs(suggested.durationMs)}。该提示仅是显示建议——不是已选中、
          当前生效或默认声音，选择语义由后续版本决定。
        </p>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div>
        <span className="voice-section-title">Revision 历史</span>
        {revisions === null ? (
          <div className="loading">正在加载 revision…</div>
        ) : revisions.length === 0 ? (
          <p className="form-hint" style={{marginTop: 8}}>
            还没有参考音频 revision，请在下方上传第一段参考音频。
          </p>
        ) : (
          <div className="revision-list" style={{marginTop: 8}}>
            {revisions.map((r) => (
              <div key={r.id} className="revision-row">
                <div className="revision-top">
                  <span className="revision-num mono">
                    r{r.revisionNumber ?? '—'}
                  </span>
                  <span className="revision-meta">
                    <span>
                      时长 <span className="mono">{formatDurationMs(r.durationMs)}</span>
                    </span>
                    <span>
                      采样率 <span className="mono">{r.sampleRate ?? '—'} Hz</span>
                    </span>
                    <span>
                      声道 <span className="mono">{r.channels ?? '—'}</span>
                    </span>
                    <span>
                      编码 <span className="mono">{r.codec ?? '—'}</span>
                    </span>
                    <span>
                      SHA{' '}
                      <span className="mono" title={r.canonicalAudioSha256 ?? undefined}>
                        {r.canonicalAudioSha256
                          ? r.canonicalAudioSha256.slice(0, 12)
                          : '—'}
                      </span>
                    </span>
                    <span>
                      兼容键 <span className="mono">{r.adapterCompatibilityKey ?? '—'}</span>
                    </span>
                    {r.language ? (
                      <span>
                        语言 <span className="mono">{r.language}</span>
                      </span>
                    ) : null}
                    <span>
                      创建 <span className="mono">{formatDateTime(r.createdAt)}</span>
                    </span>
                  </span>
                </div>
                {r.transcript ? <p className="revision-transcript">{r.transcript}</p> : null}
                <audio
                  className="voice-audio"
                  controls
                  preload="none"
                  src={`/api/voice-profiles/${profileId}/revisions/${r.id}/audio`}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <UploadRevisionForm profileId={profileId} onUploaded={() => void refresh()} />
    </div>
  );
}

// ---------- 页面 ----------

type StatusFilter = 'all' | 'active' | 'archived';

export default function VoicesSettingsPage() {
  const [profiles, setProfiles] = useState<ProfileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [patching, setPatching] = useState<string | null>(null);

  const refresh = useCallback(async (status: StatusFilter) => {
    try {
      const url =
        status === 'all' ? '/api/voice-profiles' : `/api/voice-profiles?status=${status}`;
      const res = await fetch(url, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const list = asObj(json)?.profiles;
      setProfiles(
        Array.isArray(list)
          ? list.map(normalizeProfile).filter((p): p is ProfileItem => p !== null)
          : [],
      );
      setError(null);
    } catch {
      setError('声音库加载失败，请确认服务已启动');
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    void refresh(filter);
  }, [refresh, filter]);

  const toggleStatus = useCallback(
    async (profile: ProfileItem) => {
      const next = profile.status === 'active' ? 'archived' : 'active';
      setPatching(profile.id);
      setError(null);
      try {
        const res = await fetch(`/api/voice-profiles/${profile.id}`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({status: next}),
        });
        if (!res.ok) {
          const json: unknown = await res.json().catch(() => null);
          throw new Error(apiErrorText(json, res.status));
        }
        await refresh(filter);
      } catch (err) {
        setError(err instanceof Error ? err.message : '状态更新失败');
      } finally {
        setPatching(null);
      }
    },
    [refresh, filter],
  );

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">声音库</h1>
          <p className="page-sub">
            {profiles ? `共 ${profiles.length} 个声音 Profile` : '加载中…'}
          </p>
        </div>
        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
          <select
            className="form-select"
            aria-label="按状态过滤"
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
          >
            <option value="all">全部状态</option>
            <option value="active">仅活跃</option>
            <option value="archived">仅已归档</option>
          </select>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? '收起' : '新建声音'}
          </button>
        </div>
      </div>

      <div className="legacy-note">
        <div>Revision 创建后不可修改（immutable），只能追加新 revision。</div>
        <div>此声音库尚未绑定任何项目，这里的操作不会影响任何现有项目。</div>
        <div>TTS-A 仅管理参考音频，不生成旁白。</div>
        <div>「最新参考」仅是显示建议，不是已选中 / 当前生效 / 默认声音。</div>
      </div>

      {showCreate ? (
        <CreateProfileForm
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh(filter);
          }}
        />
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      {profiles === null ? (
        <div className="loading">正在加载声音库…</div>
      ) : profiles.length === 0 ? (
        <div className="empty">
          <p className="empty-title">还没有声音 Profile</p>
          <p>点击「新建声音」创建第一个声音档案，再上传参考音频。</p>
        </div>
      ) : (
        <div className="voice-list">
          {profiles.map((p) => {
            const expanded = expandedId === p.id;
            return (
              <div key={p.id} className={`voice-row${expanded ? ' expanded' : ''}`}>
                <div className="voice-row-head">
                  <button
                    type="button"
                    className="voice-expand"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : p.id)}
                  >
                    <span className="voice-name">{p.displayName}</span>
                    <span className="badge" data-profile-status={p.status}>
                      {p.status === 'active' ? '活跃' : '已归档'}
                    </span>
                    {p.description ? (
                      <span className="voice-desc">{p.description}</span>
                    ) : null}
                  </button>
                  <div className="voice-row-meta">
                    <span>
                      provider <span className="mono">{p.provider}</span>
                    </span>
                    <span>
                      创建 <span className="mono">{formatDateTime(p.createdAt)}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={patching === p.id}
                      onClick={() => void toggleStatus(p)}
                    >
                      {patching === p.id
                        ? '更新中…'
                        : p.status === 'active'
                          ? '归档'
                          : '恢复'}
                    </button>
                  </div>
                </div>
                {expanded ? <ProfileDetail profileId={p.id} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
