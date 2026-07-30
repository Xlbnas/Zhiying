/**
 * M7.1 TTS payload v1.1 / fingerprint / 复用决策测试（Mock provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m71-tts.ts
 * 使用临时数据目录（data/test-m71-tts），结束后清理。
 * 覆盖：fingerprint deterministic/敏感性、v1.0 payload 只读兼容、
 * 复用 planner 全部 reason code、enqueue v2 的 fail-closed 门。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m71-tts');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {compileNarrationPlanV2} from '../src/lib/narration/compiler-v2';
import type {NarrationPlanV2, SpeechUnitV2} from '../src/lib/narration/schema-v2';
import {
  computeTtsInputFingerprint,
  normalizeSpokenText,
  TTS_TEXT_NORMALIZATION_VERSION,
  ttsModelVersionOf,
  voiceIdentityOf,
} from '../src/lib/tts/fingerprint';
import {
  enqueueNarrationAudioJobsV2,
  fingerprintForUnit,
  NarrationAudioV2Error,
  planTtsReuseDecisions,
  type TtsProviderSnapshot,
} from '../src/lib/narration/audio-v2';
import {
  parseTtsJobPayload,
  payloadSpokenText,
  type TtsJobResult,
} from '../src/lib/tts-jobs';
import {DEFAULT_VOICE_PROFILE} from '../src/lib/tts';
import {createProjectWithWorkflow} from '../src/lib/projects';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

const SNAPSHOT: TtsProviderSnapshot = {
  name: 'mock',
  model: 'mock-tts',
  providerVersion: '1.0.0',
  providerCommit: null,
};

function compilePlan(md: string, mode: 'strict' | 'legacy'): NarrationPlanV2 {
  return compileNarrationPlanV2({
    scriptV2Markdown: md,
    scriptV2VersionId: 'test-version-id',
    scriptV2Version: 1,
    scriptV2PromptVersion: mode === 'strict' ? 'script-v2@2.0' : 'script-v2@1.0',
    inputMode: mode,
  });
}

const LEGACY_MD = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。`;

function speechUnitOf(plan: NarrationPlanV2): SpeechUnitV2 {
  const unit = plan.units.find((u) => u.kind === 'speech');
  if (!unit || unit.kind !== 'speech') throw new Error('fixture: no speech unit');
  return unit;
}

function newProject(): string {
  return createProjectWithWorkflow({topic: 'tts-test', coreQuestion: 'q'}).project.id;
}

function resultJson(overrides: Partial<TtsJobResult> = {}): string {
  const base: TtsJobResult = {
    provider: SNAPSHOT.name,
    model: SNAPSHOT.model,
    providerVersion: SNAPSHOT.providerVersion,
    providerCommit: SNAPSHOT.providerCommit,
    settings: {voiceProfileId: 'default', voiceProfileRevision: '1', useRandom: false},
    audio: {codec: 'pcm_s16le', sampleRate: 44100, channels: 1},
  };
  return JSON.stringify({...base, ...overrides});
}

/** 手工插入一条 succeeded tts_job（复用候选池）。 */
function insertSucceededJob(input: {
  projectId: string;
  unitId?: string;
  payload: unknown;
  resultJsonOverride?: Partial<TtsJobResult>;
  rawResultJson?: string | null;
}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO tts_jobs (
         id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
         provider, voice_profile_id, voice_profile_revision,
         status, payload_json, output_path, duration_ms, audio_sha256, result_json,
         queued_at, finished_at, attempt, max_attempts
       ) VALUES (?, ?, 'legacy-plan-artifact', 1, ?, 'mock', 'default', '1',
                 'succeeded', ?, 'u.wav', 1000, 'sha', ?, ?, ?, 0, 2)`,
    )
    .run(
      id,
      input.projectId,
      input.unitId ?? 'N001',
      JSON.stringify(input.payload),
      input.rawResultJson !== undefined ? input.rawResultJson : resultJson(input.resultJsonOverride),
      now,
      now,
    );
  return id;
}

function v1Payload(unitText: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    narrationPlanArtifactId: 'legacy-plan-artifact',
    narrationPlanArtifactVersion: 1,
    scriptV2Version: 1,
    compilerVersion: '1.0',
    unitId: 'N001',
    unitText,
  };
}

function main(): void {
  // ============ fingerprint：deterministic + 敏感性 ============
  const fpInput = {
    spokenText: '第一句。',
    voiceIdentity: voiceIdentityOf(DEFAULT_VOICE_PROFILE),
    referenceAudioHash: 'none',
    ttsModelVersion: ttsModelVersionOf({
      provider: SNAPSHOT.name,
      model: SNAPSHOT.model,
      providerVersion: SNAPSHOT.providerVersion,
      providerCommit: SNAPSHOT.providerCommit,
    }),
    delivery: 'normal' as const,
    speed: '1.0',
    synthesisParameters: '{}',
    normalizationVersion: TTS_TEXT_NORMALIZATION_VERSION,
  };
  const fp1 = computeTtsInputFingerprint(fpInput);
  const fp2 = computeTtsInputFingerprint(fpInput);
  ok(fp1 === fp2, '[F1] fingerprint deterministic');
  ok(/^sha256:[0-9a-f]{64}$/.test(fp1), '[F2] fingerprint 格式 sha256:hex64');
  ok(
    computeTtsInputFingerprint({...fpInput, delivery: 'slow'}) !== fp1,
    '[F3] 文本相同但 delivery 不同 → fingerprint 不同（必须重生）',
  );
  ok(
    computeTtsInputFingerprint({...fpInput, ttsModelVersion: 'mock/other-model/1.0.0/unknown'}) !== fp1,
    '[F4] 文本相同但 model 不同 → fingerprint 不同（必须重生）',
  );
  ok(
    computeTtsInputFingerprint({...fpInput, spokenText: '第一句。  '}) === fp1,
    '[F5] 尾部空白经归一化 → fingerprint 相同',
  );
  ok(
    computeTtsInputFingerprint({...fpInput, speed: '1.1'}) !== fp1,
    '[F6] speed 不同 → fingerprint 不同',
  );
  // 长度前缀防字段边界歧义：('ab','c') vs ('a','bc') 不得碰撞
  ok(
    computeTtsInputFingerprint({...fpInput, spokenText: 'ab', voiceIdentity: 'c'}) !==
      computeTtsInputFingerprint({...fpInput, spokenText: 'a', voiceIdentity: 'bc'}),
    '[F7] 长度前缀拼接杜绝字段边界碰撞',
  );
  ok(normalizeSpokenText('  第一句。  第二句。 ') === '第一句。 第二句。', '[F8] 归一化：NFC + 空白折叠');

  // ============ payload 读取兼容 ============
  const v1 = parseTtsJobPayload(JSON.stringify(v1Payload('旧文本。')));
  ok(v1 !== null && v1.schemaVersion === '1.0' && payloadSpokenText(v1) === '旧文本。', '[P1] v1.0 payload 可读（unitText）');
  const v11 = parseTtsJobPayload(
    JSON.stringify({
      schemaVersion: 'tts-payload@1.1',
      narrationPlanArtifactId: 'a',
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: '2.0',
      unitId: 'N001',
      spokenText: '新文本。',
      delivery: 'slow',
      ttsInputFingerprint: fp1,
    }),
  );
  ok(v11 !== null && v11.schemaVersion === 'tts-payload@1.1' && payloadSpokenText(v11) === '新文本。', '[P2] v1.1 payload 可读（spokenText+delivery+fingerprint）');
  ok(parseTtsJobPayload('not json') === null, '[P3] 非法 JSON → null（不 crash）');
  ok(parseTtsJobPayload(JSON.stringify({schemaVersion: '9.9'})) === null, '[P4] 未知 schemaVersion → null');

  // ============ 复用 planner ============
  // R1: legacy 受控等价 → reuse
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: v1Payload('第一句。')});
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'reuse' &&
        reuse.decisions[0].reasonCode === 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT',
      '[R1] legacy 等价（文本+normal+voice+provider/model）→ reuse',
      reuse.decisions,
    );
  }
  // R2: delivery 不同 → rebuild
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: v1Payload('第一句。')});
    const plan = compilePlan(`# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n@delivery slow\n第一句。`, 'strict');
    ok(speechUnitOf(plan).delivery === 'slow', '[R2a] fixture：unit delivery=slow');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'rebuild' &&
        reuse.decisions[0].reasonCode === 'DELIVERY_DIFFERS_FROM_LEGACY',
      '[R2b] 文本相同但 delivery=slow → rebuild（禁止猜测复用）',
      reuse.decisions,
    );
  }
  // R3: model 快照不一致 → rebuild
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: v1Payload('第一句。'), resultJsonOverride: {model: 'other-model'}});
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'rebuild' &&
        reuse.decisions[0].reasonCode === 'LEGACY_MODEL_OR_VOICE_MISMATCH',
      '[R3] result_json model 不一致 → rebuild',
      reuse.decisions,
    );
  }
  // R4: 无文本一致旧音频 → rebuild NO_LEGACY_MATCH
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: v1Payload('完全不同的文本。')});
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'rebuild' && reuse.decisions[0].reasonCode === 'NO_LEGACY_MATCH',
      '[R4] 无文本一致旧音频 → rebuild',
      reuse.decisions,
    );
  }
  // R5: v1.1 fingerprint 精确匹配 → reuse
  {
    const projectId = newProject();
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const unit = speechUnitOf(plan);
    const fp = fingerprintForUnit(unit, SNAPSHOT, DEFAULT_VOICE_PROFILE, 'none');
    insertSucceededJob({
      projectId,
      payload: {
        schemaVersion: 'tts-payload@1.1',
        narrationPlanArtifactId: 'v2-plan-artifact',
        narrationPlanArtifactVersion: 1,
        scriptV2Version: 1,
        compilerVersion: '2.0',
        unitId: 'N001',
        spokenText: '第一句。',
        delivery: 'normal',
        ttsInputFingerprint: fp,
      },
    });
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'reuse' && reuse.decisions[0].reasonCode === 'FINGERPRINT_MATCH',
      '[R5] v1.1 fingerprint 完全一致 → reuse',
      reuse.decisions,
    );
  }
  // R6: fingerprint 差一位 → 不复用
  {
    const projectId = newProject();
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const unit = speechUnitOf(plan);
    const fp = fingerprintForUnit(unit, SNAPSHOT, DEFAULT_VOICE_PROFILE, 'none');
    insertSucceededJob({
      projectId,
      payload: {
        schemaVersion: 'tts-payload@1.1',
        narrationPlanArtifactId: 'v2-plan-artifact',
        narrationPlanArtifactVersion: 1,
        scriptV2Version: 1,
        compilerVersion: '2.0',
        unitId: 'N001',
        spokenText: '第一句。',
        delivery: 'normal',
        ttsInputFingerprint: `sha256:${'0'.repeat(63)}1`,
      },
    });
    ok(fp !== `sha256:${'0'.repeat(63)}1`, '[R6a] fixture：伪造 fingerprint 与真实不同');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(reuse.decisions[0]?.decision === 'rebuild', '[R6b] fingerprint 不一致 → rebuild', reuse.decisions);
  }
  // R7: 不可解析 payload → rebuild LEGACY_PAYLOAD_UNREADABLE
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: ' totally broken ', rawResultJson: null});
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const reuse = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(
      reuse.decisions[0]?.decision === 'rebuild' &&
        reuse.decisions[0].reasonCode === 'LEGACY_PAYLOAD_UNREADABLE',
      '[R7] 旧 payload 不可解析 → rebuild（不猜测）',
      reuse.decisions,
    );
  }
  // R8: deterministic diff report
  {
    const projectId = newProject();
    insertSucceededJob({projectId, payload: v1Payload('第一句。')});
    const plan = compilePlan(LEGACY_MD, 'legacy');
    const a = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    const b = planTtsReuseDecisions({projectId, plan, provider: SNAPSHOT});
    ok(JSON.stringify(a) === JSON.stringify(b), '[R8] 复用决策 deterministic');
    ok(a.reuseCount + a.rebuildCount === a.decisions.length, '[R9] reuse+rebuild 计数守恒');
  }

  // ============ enqueue v2 fail-closed 门 ============
  {
    const projectId = newProject();
    try {
      // M7.1.1：必须显式传 narrationPlanV2ArtifactId；不存在的 ID → NOT_FOUND
      enqueueNarrationAudioJobsV2({
        projectId,
        narrationPlanV2ArtifactId: crypto.randomUUID(),
        provider: SNAPSHOT,
      });
      ok(false, '[E1] 不存在的 plan artifact → 入队必须拒绝');
    } catch (err) {
      ok(
        err instanceof NarrationAudioV2Error && err.code === 'NARRATION_PLAN_V2_NOT_FOUND',
        '[E1] 不存在的 plan artifact → NARRATION_PLAN_V2_NOT_FOUND',
        err instanceof Error ? err.message : err,
      );
    }
    const jobCount = getDb()
      .prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?')
      .get(projectId) as {c: number};
    ok(jobCount.c === 0, '[E2] 拒绝入队后零 job 落库（事务原子）');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m71-tts'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1 TTS 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1 TTS fingerprint/复用测试全部通过 ✅');
}

main();
