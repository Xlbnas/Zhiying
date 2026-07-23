'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';

/**
 * 新建项目表单（M2-C §二十四）。
 * 必填：主题 / 核心问题；高级设置可展开（目标时长 / 语言 / 平台 / 受众 /
 * 视频风格 / 视觉风格 / 科学严谨度）。提交 → POST /api/projects → 项目页。
 */

interface ApiError {
  error?: string;
  message?: string;
}

export function NewProjectForm({onClose}: {onClose: () => void}) {
  const router = useRouter();
  const [topic, setTopic] = useState('');
  const [coreQuestion, setCoreQuestion] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [targetDuration, setTargetDuration] = useState('10 分钟');
  const [language, setLanguage] = useState('中文');
  const [platform, setPlatform] = useState('');
  const [audience, setAudience] = useState('');
  const [videoStyle, setVideoStyle] = useState('视频论文');
  const [visualStyle, setVisualStyle] = useState('');
  const [scientificRigor, setScientificRigor] = useState<'高' | '中' | '低'>('高');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = topic.trim().length > 0 && coreQuestion.trim().length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          topic: topic.trim(),
          coreQuestion: coreQuestion.trim(),
          targetDuration: targetDuration.trim() || undefined,
          language: language.trim() || undefined,
          platform: platform.trim() || undefined,
          audience: audience.trim() || undefined,
          videoStyle: videoStyle.trim() || undefined,
          visualStyle: visualStyle.trim(),
          scientificRigor,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiError | null;
        throw new Error(json?.message ?? json?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {project?: {id?: string}};
      const id = json.project?.id;
      if (!id) throw new Error('创建响应缺少项目 ID');
      router.push(`/project/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
      setBusy(false);
    }
  };

  return (
    <section className="new-project fade-in" aria-label="新建项目">
      <div className="form-grid">
        <div className="form-field full">
          <label className="form-label" htmlFor="np-topic">
            主题 *
          </label>
          <input
            id="np-topic"
            className="form-input"
            placeholder="例如：为什么我们总在最后一刻才开始"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-field full">
          <label className="form-label" htmlFor="np-question">
            核心问题 *
          </label>
          <input
            id="np-question"
            className="form-input"
            placeholder="一个可研究、非结论预设的问题，例如：拖延只是时间管理问题吗？"
            value={coreQuestion}
            onChange={(e) => setCoreQuestion(e.target.value)}
          />
        </div>

        {showAdvanced ? (
          <>
            <div className="form-field">
              <label className="form-label" htmlFor="np-duration">
                目标时长
              </label>
              <input
                id="np-duration"
                className="form-input"
                value={targetDuration}
                onChange={(e) => setTargetDuration(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-language">
                语言
              </label>
              <input
                id="np-language"
                className="form-input"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-platform">
                平台
              </label>
              <input
                id="np-platform"
                className="form-input"
                placeholder="B站 / YouTube / 小红书"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-audience">
                受众
              </label>
              <input
                id="np-audience"
                className="form-input"
                placeholder="例如：对心理学感兴趣的普通观众"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-vstyle">
                视频风格
              </label>
              <input
                id="np-vstyle"
                className="form-input"
                value={videoStyle}
                onChange={(e) => setVideoStyle(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-visual">
                视觉风格
              </label>
              <input
                id="np-visual"
                className="form-input"
                placeholder="留空 = 由 AI 按项目上下文提案"
                value={visualStyle}
                onChange={(e) => setVisualStyle(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="np-rigor">
                科学严谨度
              </label>
              <select
                id="np-rigor"
                className="form-select"
                value={scientificRigor}
                onChange={(e) => setScientificRigor(e.target.value as '高' | '中' | '低')}
              >
                <option value="高">高</option>
                <option value="中">中</option>
                <option value="低">低</option>
              </select>
            </div>
          </>
        ) : null}
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="form-foot">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '收起高级设置' : '展开高级设置'}
        </button>
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
            {busy ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
      <p className="form-hint">创建后将初始化 10 阶段工作流；第一步是「选题定义」。</p>
    </section>
  );
}
