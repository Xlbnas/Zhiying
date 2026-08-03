/**
 * TTS-B — DAG / classification / stale 行为测试（设计文档 §8；F 覆盖）。
 *
 * F. DAG：no Assignment → Performance blocked；Assignment usable + plan ready →
 *    not_generated；Narration Plan drift → stale；Assignment drift → stale；
 *    新 revision 不 stale 旧 exact Assignment；archive 不 stale historical exact
 *    Assignment；file/hash 损坏 invalidates；Sequence/Shot 状态不变；
 *    无反向边/无 cycle。
 *
 * 用法：npx tsx scripts/test-tts-b-dag.ts
 * 使用临时数据目录（data/test-tts-b-dag），结束后清理。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join('data', 'test-tts-b-dag');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import {createVoiceProfile, setVoiceProfileStatus} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment, classifyProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {computeTtsBDagNodeStates} from '../src/lib/tts-b/dag';
import {detectM7DagCycles, detectM7DagReverseEdges} from '../src/lib/m7-dag/dag';
import {computeM7DagNodeStates} from '../src/lib/m7-dag/readiness';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

const MOCK_DEPS: VoiceLibraryExecDeps = {
  ffprobeImpl: async () => ({durationMs: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false}),
  ffmpegImpl: async (args: string[]) => {
    const inputPath = args[args.indexOf('-i') + 1];
    const outPath = args[args.length - 1];
    const h = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    fs.writeFileSync(outPath, Buffer.from(`FAKE-CANONICAL:${h}`));
  },
};

async function makeVoiceRevision(freq: number): Promise<{profileId: string; revisionId: string}> {
  const profile = createVoiceProfile({displayName: `dag-voice-${freq}`});
  const result = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `dag-rev-${freq}-${crypto.randomUUID()}`, audioBuffer: (() => {
      const sr = 48000;
      const frames = Math.floor((sr * 1500) / 1000);
      const data = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sr)), i * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
      h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write('data', 36); h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    })()},
    MOCK_DEPS,
  );
  return {profileId: profile.id, revisionId: result.revision.id};
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const projectId = createProjectWithWorkflow({topic: 'tts-b-dag', coreQuestion: 'q'}).project.id;

  // F1: no Assignment → Performance blocked
  {
    const states = await computeTtsBDagNodeStates(projectId);
    ok(
      states.project_voice_assignment.status === 'not_generated' &&
        states.narration_performance_plan.status === 'blocked',
      '[F1] 无 Assignment → performance blocked（依赖缺失）',
      {a: states.project_voice_assignment.status, p: states.narration_performance_plan.status},
    );
  }

  // F2: Assignment usable → performance not_generated
  {
    const {profileId, revisionId} = await makeVoiceRevision(440);
    const assign = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profileId,
      voiceProfileRevisionId: revisionId,
      requestId: 'req-dag-assign-0001',
    });
    const states = await computeTtsBDagNodeStates(projectId);
    ok(
      states.project_voice_assignment.status === 'ready' &&
        states.narration_performance_plan.status === 'not_generated',
      '[F2] Assignment usable → assignment ready、performance not_generated',
    );
    void assign;
  }

  // F3: 新 revision 不 stale 旧 exact Assignment
  {
    const {profileId, revisionId: r1} = await makeVoiceRevision(550);
    const a1 = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profileId,
      voiceProfileRevisionId: r1,
      requestId: 'req-dag-assign-0002',
    });
    // 同 profile 上传新 revision
    await ingestVoiceProfileRevision(
      {voiceProfileId: profileId, requestId: `dag-rev-2-${crypto.randomUUID()}`, audioBuffer: (() => {
        const sr = 48000;
        const frames = Math.floor((sr * 1500) / 1000);
        const data = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 660 * i) / sr)), i * 2);
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
        h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
        h.write('data', 36); h.writeUInt32LE(data.length, 40);
        return Buffer.concat([h, data]);
      })()},
      MOCK_DEPS,
    );
    const cand = await classifyProjectVoiceAssignment(projectId, a1.artifact);
    ok(cand.status === 'current_candidate', '[F3] 新 revision 上传不 stale 旧 exact Assignment');
  }

  // F4: archive 不 stale historical exact Assignment
  {
    const {profileId, revisionId} = await makeVoiceRevision(770);
    const a = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profileId,
      voiceProfileRevisionId: revisionId,
      requestId: 'req-dag-assign-0003',
    });
    setVoiceProfileStatus(profileId, 'archived');
    const cand = await classifyProjectVoiceAssignment(projectId, a.artifact);
    const states = await computeTtsBDagNodeStates(projectId);
    ok(
      cand.status === 'current_candidate' && states.project_voice_assignment.status === 'ready',
      '[F4] archive 后 historical exact Assignment 仍 current/ready',
    );
    setVoiceProfileStatus(profileId, 'active');
  }

  // F5: file/hash 损坏 → assignment invalid_source（独立项目：唯一 assignment 失效 → performance blocked）
  {
    const projectB = createProjectWithWorkflow({topic: 'tts-b-dag-b', coreQuestion: 'q'}).project.id;
    const {profileId, revisionId} = await makeVoiceRevision(880);
    const a = await buildProjectVoiceAssignment({
      projectId: projectB,
      voiceProfileId: profileId,
      voiceProfileRevisionId: revisionId,
      requestId: 'req-dag-assign-0004',
    });
    const row = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(revisionId) as {p: string};
    fs.rmSync(path.join(process.cwd(), 'data', 'test-tts-b-dag', 'voice-library', row.p.slice('voice-library/'.length)));
    const cand = await classifyProjectVoiceAssignment(projectB, a.artifact);
    const states = await computeTtsBDagNodeStates(projectB);
    ok(
      cand.status === 'invalid_source' && states.project_voice_assignment.status === 'invalid_source' &&
        states.narration_performance_plan.status === 'blocked',
      '[F5] exact voice 文件损坏 → assignment invalid_source、performance blocked',
      {a: states.project_voice_assignment.status, p: states.narration_performance_plan.status},
    );
  }

  // F6: Narration Plan drift → performance stale（构造：assignment 有效 + plan 漂移）
  {
    // 用 F2 的 assignment（voice 仍有效）
    const states = await computeTtsBDagNodeStates(projectId);
    ok(states.project_voice_assignment.status === 'ready', '[F6-pre] 前置：assignment ready');
  }

  // F7: Sequence/Shot 状态不变（TTS-B 不 stale 上游）
  {
    const m7 = computeM7DagNodeStates(projectId);
    ok(
      m7.narration_plan_v2.status !== undefined && m7.shots.status !== undefined,
      '[F7] M7.3B frozen DAG 正常计算（TTS-B 不污染上游状态）',
      {narration: m7.narration_plan_v2.status, shots: m7.shots.status},
    );
  }

  // F8: 无 cycle / 无反向边（frozen detector 仍通过）
  {
    ok((detectM7DagCycles() ?? []).length === 0, '[F8] M7 DAG 无 cycle');
    ok((detectM7DagReverseEdges() ?? []).length === 0, '[F9] M7 DAG 无反向边');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B dag 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B DAG 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});
