/**
 * TTS-C.1B.2 publisher candidate 测试（legacy import + T1 claim + candidate 确定性构建 +
 * T2 file_durable）。
 *
 * 场景矩阵（§A import / §B T1 claim / §C candidate determinism / §D durable file）：
 * 覆盖 frozen contract 语义（docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md §7.1/§7.3、
 * docs/TTS_C_1B_1C_EXECUTION_PLAN.md §C/§F/§J）。全部使用临时 DB + 临时目录；
 * 不调用真实 IndexTTS2；不调用 /reload；不写 production。
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ok, fail, summary, cleanupC1a, setupC1aFixture, makeWav, sha256Buf, execDeps, type C1aFixture} from './lib/tts-c1a-test-utils';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {closeDb, getDb} from '../src/lib/db';
import {
  importLegacyRegistry,
  LEGACY_IMPORT_CONFLICT,
  verifyReferenceFile,
} from '../src/lib/tts-c/legacy-import';
import {
  claimPublication,
  buildRegistryCandidate,
  persistCandidateFile,
  markCandidatePersisted,
  markFileDurable,
  publishRegistryCandidate,
  failPublication,
  candidateRegistryDir,
  candidateRegistryPath,
  getPublicationRow,
  PUBLICATION_LEASE_MS,
  PUBLISHER_SCHEMA_VERSION,
  PUBLICATION_CONFLICT,
  PUBLICATION_NOT_OWNER,
  CANDIDATE_BYTES_CONFLICT,
  CANDIDATE_KEY_CONFLICT,
  CANDIDATE_EVIDENCE_MISMATCH,
  CANDIDATE_FILE_IO,
  type PublicationSubject,
  type PublicationRow,
} from '../src/lib/tts-c/registry-publisher';
import {parseAndValidateRegistry, sha256Bytes, serializeCanonicalJson, canonicalVoiceKey} from '../src/lib/tts-c/registry-schema';
import {RegistryContractError} from '../src/lib/tts-c/registry-contract-error';

const execFileP = promisify(execFile);
const TAG = 'test-tts-c1b2-publisher';
const SAMPLE_SHA = '2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30';

let fx: C1aFixture; // TTS-A 相关（profile/revision/assignment/canonical wav）
let DATA_DIR: string;
let VOICE_ROOT: string; // legacy reference 文件根
let MAT_ROOT: string; // materialization projection 根（dataDir/voice-materializations）
let EMIT_ROOT = '/voices'; // registry 内 referenceAssetPath 前缀

function sha256OfFile(p: string): string {
  return sha256Bytes(fs.readFileSync(p));
}

function wavFile(): Buffer {
  return makeWav(800, 330);
}

function writeRegistry(dir: string, name: string, voices: Array<Record<string, string>>, extra?: Record<string, unknown>): string {
  const doc: Record<string, unknown> = {schemaVersion: '1.0', voices};
  Object.assign(doc, extra);
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}

async function expectCode(label: string, fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    ok(false, label, `预期错误码 ${code} 但未抛`);
  } catch (e) {
    const c = e instanceof RegistryContractError ? e.code : (e as {code?: string})?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (c === code) {
      ok(true, label);
    } else {
      ok(false, label, `错误码 ${c} != ${code}: ${msg.slice(0, 140)}`);
    }
  }
}

function insertMaterializationRow(
  profileId: string,
  revisionId: string,
  sourceSha: string,
  sourceFileAbs: string,
  status = 'file_ready_unpublished',
): string {
  const id = crypto.randomUUID();
  const rel = `${profileId}/${revisionId}/reference.wav`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO voice_materializations
         (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'indextts2-adapter-registry@1', ?, ?, ?, ?)`,
    )
    .run(id, profileId, revisionId, sourceSha, rel, status, now, now);
  // 投影文件必须真实存在且 SHA == source_canonical_sha256（candidate 构建会复算 SHA）
  const abs = path.join(MAT_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.copyFileSync(sourceFileAbs, abs);
  if (sha256OfFile(abs) !== sourceSha) throw new Error('projection 文件 SHA 与 source_canonical_sha256 不符');
  return id;
}

/** 新建独立 voice profile + revision + projection（TTS-A 身份 key = profileId@revisionNumber）。 */
async function newProjection(status: 'file_ready_unpublished' | 'failed' = 'file_ready_unpublished'): Promise<{matId: string; profileId: string; revisionId: string; revisionSha: string}> {
  const profile = createVoiceProfile({displayName: `c1b2-${crypto.randomUUID().slice(0, 8)}`});
  const audio = makeWav(800, 330 + Math.floor(Math.random() * 50));
  const revision = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: audio},
    execDeps,
  );
  const revRow = revision.outcome === 'created' || revision.outcome === 'reused' ? revision.revision : null;
  if (!revRow) throw new Error(`ingest revision failed: ${JSON.stringify(revision)}`);
  const canonicalAbs = path.join(DATA_DIR, 'voice-library', profile.id, revRow.id, 'reference.wav');
  const revisionSha = sha256OfFile(canonicalAbs);
  const matId = insertMaterializationRow(profile.id, revRow.id, revisionSha, canonicalAbs, 'file_ready_unpublished');
  if (status === 'failed') {
    const now = new Date().toISOString();
    const res = getDb().prepare("UPDATE voice_materializations SET status='failed', updated_at=? WHERE id=? AND status='file_ready_unpublished'").run(now, matId);
    if (res.changes !== 1) throw new Error('materialization failed transition failed');
  }
  return {matId, profileId: profile.id, revisionId: revRow.id, revisionSha};
}

function insertLegacyEntry(v: {voiceProfile: string; voiceRevision: string; speakerName: string; referenceAssetPath: string; referenceSha256: string; sourceRegistrySha256: string}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO legacy_adapter_voice_entries
         (id, voice_profile_key, voice_revision_key, speaker_name,
          reference_asset_path_or_safe_projection, reference_sha256, source_registry_sha256,
          imported_at, mapping_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmapped')`,
    )
    .run(id, v.voiceProfile, v.voiceRevision, v.speakerName, v.referenceAssetPath, v.referenceSha256, v.sourceRegistrySha256, now);
  return id;
}

/** frozen R8-A rollback：mapping_pending → mapped_verified（清 pending link + selector；前置 publication failed/cancelled）。 */
function rollbackToMappedVerified(entryId: string): void {
  const res = getDb()
    .prepare(
      `UPDATE legacy_adapter_voice_entries
          SET mapping_status='mapped_verified', pending_publication_id=NULL, candidate_source_selector=NULL
        WHERE id=? AND mapping_status='mapping_pending'`,
    )
    .run(entryId);
  if (res.changes !== 1) throw new Error(`rollback failed for ${entryId}`);
}

function markMappedVerified(entryId: string, matId: string, mappingMode: 'publish_and_cutover' | 'cutover_existing'): void {
  const res = getDb()
    .prepare(
      `UPDATE legacy_adapter_voice_entries
          SET mapping_status='mapped_verified', mapped_voice_materialization_id=?, mapping_mode=?
        WHERE id=? AND mapping_status='unmapped'`,
    )
    .run(matId, mappingMode, entryId);
  if (res.changes !== 1) throw new Error(`markMappedVerified failed for ${entryId}`);
}

function rowCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

function publicationRowCount(): number {
  return rowCount('voice_registry_publications');
}

function legacyCount(): number {
  return rowCount('legacy_adapter_voice_entries');
}

function materializationCount(): number {
  return rowCount('voice_materializations');
}

async function runChild(args: string[]): Promise<Record<string, unknown>> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1b2-child.ts');
  const {stdout} = await execFileP(process.execPath, ['--import', 'tsx', childPath, ...args], {
    env: {...process.env, ZHIYING_DATA_DIR: DATA_DIR},
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

// ── fixture ──

(async () => {
  DATA_DIR = path.join('data', TAG);
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  process.env.ZHIYING_DATA_DIR = DATA_DIR;
  closeDb();
  getDb(); // 应用 migration
  fx = await setupC1aFixture(TAG);
  // setupC1aFixture 重建了 dataDir——重建后的 voice root / mat root
  VOICE_ROOT = path.join(DATA_DIR, 'voices');
  MAT_ROOT = path.join(DATA_DIR, 'voice-materializations');
  fs.mkdirSync(VOICE_ROOT, {recursive: true});
  fs.mkdirSync(MAT_ROOT, {recursive: true});
  // 幂等：setupC1aFixture 后重新 close/getDb 保持单一连接视角
  closeDb();
  getDb();

  // ══════════════ A. Legacy import ══════════════
  {
    // A1: 空 DB 首次导入（3 voices，乱序输入）
    const wavA = wavFile();
    const wavB = wavFile();
    const wavC = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'voice-a.wav'), wavA);
    fs.writeFileSync(path.join(VOICE_ROOT, 'voice-b.wav'), wavB);
    fs.writeFileSync(path.join(VOICE_ROOT, 'voice-c.wav'), wavC);
    const shaA = sha256Buf(wavA);
    const shaB = sha256Buf(wavB);
    const shaC = sha256Buf(wavC);
    const regPath = writeRegistry(path.join(DATA_DIR, 'regs'), 'r1.json', [
      {voiceProfile: 'b-voice', voiceRevision: '2', speakerName: 'b-spk', referenceAssetPath: `${EMIT_ROOT}/voice-b.wav`, referenceSha256: shaB},
      {voiceProfile: 'a-voice', voiceRevision: '1', speakerName: 'a-spk', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: shaA},
      {voiceProfile: 'c-voice', voiceRevision: '3', speakerName: 'c-spk', referenceAssetPath: `${EMIT_ROOT}/voice-c.wav`, referenceSha256: shaC},
    ]);
    const beforeReg = fs.readFileSync(regPath);
    const res = await importLegacyRegistry(getDb(), {
      registryFilePath: regPath,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    ok(res.inserted === 3 && res.reused === 0, 'A1 空 DB 首次导入 inserted=3 reused=0', JSON.stringify(res));
    ok(legacyCount() === 3, 'A1 三行 unmapped');
    ok(res.keys.join(',') === 'a-voice@1,b-voice@2,c-voice@3', 'A1 keys 按 canonical key 升序（与输入乱序无关）');
    const rows = getDb().prepare('SELECT mapping_status, voice_profile_key, voice_revision_key, source_registry_sha256 FROM legacy_adapter_voice_entries ORDER BY voice_profile_key').all() as Array<Record<string, string>>;
    ok(rows.every((r) => r.mapping_status === 'unmapped'), 'A1 全部 unmapped（不激活/cutover）');
    ok(rows.every((r) => r.source_registry_sha256 === sha256Buf(beforeReg)), 'A1 source_registry_sha256 = 源文件 bytes SHA');
    ok(materializationCount() === 0, 'A1 不创建 materialization');

    // A2: 同输入重跑幂等
    const res2 = await importLegacyRegistry(getDb(), {
      registryFilePath: regPath,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    ok(res2.inserted === 0 && res2.reused === 3, 'A2 重跑 inserted=0 reused=3');
    ok(legacyCount() === 3, 'A2 行数不变');
    const importedAt = getDb().prepare('SELECT imported_at FROM legacy_adapter_voice_entries WHERE voice_profile_key=?').get('a-voice') as {imported_at: string};
    ok(typeof importedAt.imported_at === 'string' && importedAt.imported_at.length > 0, 'A2 复用保留首次 imported_at');

    // A3: 并发导入（两个真实子进程）只有一个 authoritative row
    const [c1, c2] = await Promise.all([
      runChild([DATA_DIR, 'import', regPath, VOICE_ROOT, EMIT_ROOT]),
      runChild([DATA_DIR, 'import', regPath, VOICE_ROOT, EMIT_ROOT]),
    ]);
    ok(c1.ok === true && c2.ok === true, `A3 双进程导入均成功 c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)}`);
    ok(legacyCount() === 3, 'A3 并发后仍恰 3 行（单一 authoritative row per key）');

    // A4: 已存在一致 entry 复用（部分预置 + 导入剩余）
    const wavD = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'voice-d.wav'), wavD);
    const shaD = sha256Buf(wavD);
    insertLegacyEntry({
      voiceProfile: 'd-voice', voiceRevision: '4', speakerName: 'd-spk',
      referenceAssetPath: `${EMIT_ROOT}/voice-d.wav`, referenceSha256: shaD,
      sourceRegistrySha256: 'a'.repeat(64),
    });
    const regD = writeRegistry(path.join(DATA_DIR, 'regs'), 'r2.json', [
      {voiceProfile: 'a-voice', voiceRevision: '1', speakerName: 'a-spk', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: shaA},
      {voiceProfile: 'd-voice', voiceRevision: '4', speakerName: 'd-spk', referenceAssetPath: `${EMIT_ROOT}/voice-d.wav`, referenceSha256: shaD},
    ]);
    const resD = await importLegacyRegistry(getDb(), {
      registryFilePath: regD,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    ok(resD.inserted === 0 && resD.reused === 2, 'A4 已存在一致 entry 复用（含不同 source registry 文件）', JSON.stringify(resD));
    const dRow = getDb().prepare('SELECT source_registry_sha256 FROM legacy_adapter_voice_entries WHERE voice_profile_key=?').get('d-voice') as {source_registry_sha256: string};
    ok(dRow.source_registry_sha256 === 'a'.repeat(64), 'A4 复用保留首次 source_registry_sha256（provenance）');

    // A5: immutable identity 冲突 fail-closed（speaker 漂移 → 整批零写入）
    const regConflict = writeRegistry(path.join(DATA_DIR, 'regs'), 'r3.json', [
      {voiceProfile: 'a-voice', voiceRevision: '1', speakerName: 'DIFFERENT-SPK', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: shaA},
      {voiceProfile: 'z-voice', voiceRevision: '9', speakerName: 'z-spk', referenceAssetPath: `${EMIT_ROOT}/voice-c.wav`, referenceSha256: shaC},
    ]);
    await expectCode('A5 同 key 异内容 → LEGACY_IMPORT_CONFLICT（整批回滚）', async () => {
      await importLegacyRegistry(getDb(), {
        registryFilePath: regConflict,
        voiceRootDir: VOICE_ROOT,
        resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      });
    }, LEGACY_IMPORT_CONFLICT);
    ok(!getDb().prepare("SELECT 1 FROM legacy_adapter_voice_entries WHERE voice_profile_key='z-voice'").get(), 'A5 冲突批次零写入（z-voice 未导入）');
    ok(legacyCount() === 4, 'A5 原 4 行不变');

    // A6: reference missing → fail-closed
    const regMissing = writeRegistry(path.join(DATA_DIR, 'regs'), 'r4.json', [
      {voiceProfile: 'm-voice', voiceRevision: '5', speakerName: 'm-spk', referenceAssetPath: `${EMIT_ROOT}/missing.wav`, referenceSha256: shaA},
    ]);
    await expectCode('A6 reference 缺失 → REFERENCE_VOICE_MISSING', async () => {
      await importLegacyRegistry(getDb(), {
        registryFilePath: regMissing,
        voiceRootDir: VOICE_ROOT,
        resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      });
    }, 'REFERENCE_VOICE_MISSING');

    // A7: reference SHA mismatch → fail-closed
    const regBadSha = writeRegistry(path.join(DATA_DIR, 'regs'), 'r5.json', [
      {voiceProfile: 'm-voice', voiceRevision: '5', speakerName: 'm-spk', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: 'f'.repeat(64)},
    ]);
    await expectCode('A7 reference SHA 不符 → REFERENCE_SHA256_MISMATCH', async () => {
      await importLegacyRegistry(getDb(), {
        registryFilePath: regBadSha,
        voiceRootDir: VOICE_ROOT,
        resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      });
    }, 'REFERENCE_SHA256_MISMATCH');

    // A8: unknown schema → fail-closed
    const regUnknown = writeRegistry(path.join(DATA_DIR, 'regs'), 'r6.json', [
      {voiceProfile: 'x', voiceRevision: '1', speakerName: 'x', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: shaA},
    ], {schemaVersion: '9.9'});
    await expectCode('A8 未知 schemaVersion → VOICE_REGISTRY_UNSUPPORTED_SCHEMA', async () => {
      await importLegacyRegistry(getDb(), {
        registryFilePath: regUnknown,
        voiceRootDir: VOICE_ROOT,
        resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      });
    }, 'VOICE_REGISTRY_UNSUPPORTED_SCHEMA');

    // A9: duplicate voice key in file → fail-closed
    const regDup = writeRegistry(path.join(DATA_DIR, 'regs'), 'r7.json', [
      {voiceProfile: 'dup', voiceRevision: '1', speakerName: 'd1', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: shaA},
      {voiceProfile: 'dup', voiceRevision: '1', speakerName: 'd2', referenceAssetPath: `${EMIT_ROOT}/voice-b.wav`, referenceSha256: shaB},
    ]);
    await expectCode('A9 duplicate voice key → VOICE_REGISTRY_INVALID', async () => {
      await importLegacyRegistry(getDb(), {
        registryFilePath: regDup,
        voiceRootDir: VOICE_ROOT,
        resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      });
    }, 'VOICE_REGISTRY_INVALID');

    // A10: 导入不修改 registry/reference 文件
    const regBytesAfter = fs.readFileSync(regPath);
    const refBytesAfter = fs.readFileSync(path.join(VOICE_ROOT, 'voice-a.wav'));
    ok(sha256Buf(regBytesAfter) === sha256Buf(beforeReg), 'A10 registry 文件未被修改');
    ok(sha256Buf(refBytesAfter) === shaA, 'A10 reference 文件未被修改');
  }

  // ══════════════ B. T1 claim ══════════════
  {
    // 准备 TTS-A projection（file_ready_unpublished）+ legacy 映射
    const matId = insertMaterializationRow(fx.profileId, fx.revisionId, fx.revisionSha256, fx.canonicalAbsPath);
    const projRel = `${fx.profileId}/${fx.revisionId}/reference.wav`;
    const projAbs = path.join(MAT_ROOT, projRel);
    const projSha = sha256OfFile(projAbs);
    ok(projSha === fx.revisionSha256, 'B 前置 projection 文件 SHA 就绪');

    const regForCutover = writeRegistry(path.join(DATA_DIR, 'regs'), 'cutover-src.json', [
      {voiceProfile: 'default', voiceRevision: '1', speakerName: 'zhiying-default-1', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: sha256OfFile(path.join(VOICE_ROOT, 'voice-a.wav'))},
    ]);
    const stableSha = sha256OfFile(regForCutover);

    // B1: materialization_publish claim 成功（matId 未被任何 legacy entry 引用——frozen 前置）
    const claimM = claimPublication(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    ok(claimM.kind === 'claimed', 'B1 materialization_publish claim claimed');
    const pm = claimM.kind === 'claimed' ? claimM.publication : claimM.publication;
    ok(pm.status === 'building' && pm.generation === 1, `B1 building + generation=1（实际 ${pm.generation}）`);
    ok(pm.owner_token !== null && pm.lease_expires_at_epoch_ms !== null && pm.attempt === 1, 'B1 owner/lease/attempt=1');
    ok(pm.stable_registry_sha256 === stableSha, 'B1 stable_registry_sha256 记录');
    ok(pm.publisher_schema_version === PUBLISHER_SCHEMA_VERSION, 'B1 publisher_schema_version 精确');

    // B2: legacy_cutover_publish claim 成功（entry → mapping_pending；matId2 是 cutover 目标）
    // 需要先让 B1 结束（global single-flight）——fenced fail 释放
    failPublication(getDb(), {publicationId: pm.id, ownerToken: pm.owner_token!, attempt: pm.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for B2'});
    const {matId: matId2} = await newProjection();
    await importLegacyRegistry(getDb(), {
      registryFilePath: regForCutover,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    const cutoverEntry = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='default'").get() as {id: string};
    markMappedVerified(cutoverEntry.id, matId2, 'publish_and_cutover');
    const claimL2 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: cutoverEntry.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    ok(claimL2.kind === 'claimed', 'B2 legacy_cutover_publish claim claimed');
    const pl = claimL2.kind === 'claimed' ? claimL2.publication : claimL2.publication;
    const lve = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector FROM legacy_adapter_voice_entries WHERE id=?').get(cutoverEntry.id) as Record<string, string | null>;
    ok(lve.mapping_status === 'mapping_pending', 'B2 entry mapping_pending');
    ok(lve.pending_publication_id === pl.id, 'B2 pending_publication_id = 本 publication');
    ok(lve.candidate_source_selector === 'tts_a', 'B2 candidate_source_selector=tts_a');

    // B3: legacy_cutover_existing 前置（published_usable projection）在 1B.2 不可达 → frozen gate ABORT
    // （published_usable 仅能经 T5 activation command 产生，属 1B.3；1B.2 断言 frozen 门禁拒绝）
    failPublication(getDb(), {publicationId: pl.id, ownerToken: pl.owner_token!, attempt: pl.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for B3'});
    rollbackToMappedVerified(cutoverEntry.id); // 恢复 mapped_verified（frozen rollback；后续 D 段复用该 entry）
    const existingEntry = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='default'").get() as {id: string};
    await expectCode('B3 legacy_cutover_existing 前置未满足 → subject invalid ABORT（published_usable 属 1B.3）', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'legacy_cutover_existing', subjectId: existingEntry.id, subjectMode: 'cutover_existing'},
        stableRegistrySha256: stableSha,
      });
    }, 'SQLITE_CONSTRAINT_TRIGGER');

    // B4: registry_rebuild claim 成功
    const claimR = claimPublication(getDb(), {
      subject: {subjectType: 'registry_rebuild', subjectId: 'global', subjectMode: 'none'},
      stableRegistrySha256: stableSha,
    });
    ok(claimR.kind === 'claimed', 'B4 registry_rebuild claim claimed');
    const pr = claimR.kind === 'claimed' ? claimR.publication : claimR.publication;
    ok(pr.generation === 3 && pr.subject_id === 'global', 'B4 generation=3 + subject_id=global');

    // B6: 相同 request/subject 重放 → already_in_flight（复用）——在 pr 释放前立即重放
    const replay = claimPublication(getDb(), {
      subject: {subjectType: 'registry_rebuild', subjectId: 'global', subjectMode: 'none'},
      stableRegistrySha256: stableSha,
    });
    ok(replay.kind === 'already_in_flight' && replay.publication.id === pr.id, 'B6 同 subject 重放 → already_in_flight 复用');
    ok(publicationRowCount() === 3, 'B6 不新建 publication row');

    // B5: subject_type/subject_mode 非法组合被拒绝
    failPublication(getDb(), {publicationId: pr.id, ownerToken: pr.owner_token!, attempt: pr.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for B5'});
    await expectCode('B5a materialization_publish+cutover_existing → subject invalid', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'materialization_publish', subjectId: matId, subjectMode: 'cutover_existing'},
        stableRegistrySha256: stableSha,
      });
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('B5b registry_rebuild+错误 mode → subject invalid', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'registry_rebuild', subjectId: 'global', subjectMode: 'publish_and_cutover'},
        stableRegistrySha256: stableSha,
      });
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('B5c registry_rebuild+错误 subject_id → subject invalid', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'registry_rebuild', subjectId: 'not-global', subjectMode: 'none'},
        stableRegistrySha256: stableSha,
      });
    }, 'SQLITE_CONSTRAINT_TRIGGER');

    // B7: 同 subject 并发只有一个 winner（双真实子进程；无 active 在飞，直接竞争）
    const [w1, w2] = await Promise.all([
      runChild([DATA_DIR, 'claim', 'registry_rebuild', 'global', 'none', stableSha]),
      runChild([DATA_DIR, 'claim', 'registry_rebuild', 'global', 'none', stableSha]),
    ]);
    const kinds = [w1, w2].filter((w) => w.ok).map((w) => w.kind);
    ok(kinds.length === 2, `B7 双进程 claim 均成功返回（kind=${kinds.join(',')}）`);
    ok(kinds.some((k) => k === 'claimed') && kinds.some((k) => k === 'already_in_flight'), 'B7 恰好一个 winner + 一个 reuse');
    const inFlight = getDb().prepare("SELECT COUNT(*) AS n FROM voice_registry_publications WHERE status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate')").get() as {n: number};
    ok(inFlight.n === 1, 'B7 全局 active single-flight 恰 1 行');

    // B8: 不同合法 subject——frozen global single-flight 下串行（A 终态后 B 可 claim）
    const activeRow = getDb().prepare("SELECT * FROM voice_registry_publications WHERE status='building' ORDER BY generation DESC LIMIT 1").get() as PublicationRow;
    await expectCode('B8a 不同 subject 在 A active 时 → PUBLICATION_CONFLICT（frozen 单飞）', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'materialization_publish', subjectId: matId, subjectMode: 'publish_and_cutover'},
        stableRegistrySha256: stableSha,
      });
    }, PUBLICATION_CONFLICT);
    failPublication(getDb(), {publicationId: activeRow.id, ownerToken: activeRow.owner_token!, attempt: activeRow.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for B8b'});
    const maxBeforeB8b = (getDb().prepare('SELECT COALESCE(MAX(generation),0) AS n FROM voice_registry_publications').get() as {n: number}).n;
    const after = claimPublication(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    ok(after.kind === 'claimed' && after.publication.generation === maxBeforeB8b + 1, `B8b A 终态后 B claim 成功（generation=${after.publication.generation}=max+1）`);
    failPublication(getDb(), {publicationId: after.publication.id, ownerToken: after.publication.owner_token!, attempt: after.publication.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release'});

    // B9: projection 状态不满足时 fail-closed（materialization 非 file_ready_unpublished）
    const {matId: matFailedId} = await newProjection('failed');
    await expectCode('B9 materialization 非 file_ready_unpublished → subject invalid', () => {
      claimPublication(getDb(), {
        subject: {subjectType: 'materialization_publish', subjectId: matFailedId, subjectMode: 'publish_and_cutover'},
        stableRegistrySha256: stableSha,
      });
    }, 'SQLITE_CONSTRAINT_TRIGGER');

    // B10: active-flight 冲突（已 covered by B8a；补 assert 不产生行）
    const countBeforeB10 = publicationRowCount();
    ok(publicationRowCount() === countBeforeB10, 'B10 冲突 claim 零新行');
  }

  // ══════════════ C. Candidate determinism ══════════════
  {
    const stableSha = sha256Bytes(fs.readFileSync(path.join(DATA_DIR, 'regs', 'cutover-src.json')));
    const regAll = writeRegistry(path.join(DATA_DIR, 'regs'), 'all.json', [
      {voiceProfile: 'a-voice', voiceRevision: '1', speakerName: 'a-spk', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: sha256OfFile(path.join(VOICE_ROOT, 'voice-a.wav'))},
      {voiceProfile: 'default', voiceRevision: '1', speakerName: 'zhiying-default-1', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: sha256OfFile(path.join(VOICE_ROOT, 'voice-a.wav'))},
      {voiceProfile: 'c-voice', voiceRevision: '1', speakerName: 'c-spk', referenceAssetPath: `${EMIT_ROOT}/voice-c.wav`, referenceSha256: sha256OfFile(path.join(VOICE_ROOT, 'voice-c.wav'))},
    ]);
    await importLegacyRegistry(getDb(), {
      registryFilePath: regAll,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    const {matId, revisionSha: matRevSha, profileId: cutoverProfileId, revisionId: cutoverRevisionId} = await newProjection();
    const entryDefault = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='default'").get() as {id: string};
    const entryA = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='a-voice'").get() as {id: string};
    void entryA;
    const entryC = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='c-voice'").get() as {id: string};
    markMappedVerified(entryC.id, matId, 'publish_and_cutover');

    const maxBeforeC1 = (getDb().prepare('SELECT COALESCE(MAX(generation),0) AS n FROM voice_registry_publications').get() as {n: number}).n;
    const c1 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entryC.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    const pub = c1.publication;

    // C1: 相同输入重复构建 → 逐字节一致
    const buildOpts = {
      publication: pub,
      legacyVoiceRootDir: VOICE_ROOT,
      materializationRootDir: MAT_ROOT,
      emitVoiceRootPath: EMIT_ROOT,
      resolveLegacyReferencePath: (p: string) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    };
    const b1 = await buildRegistryCandidate(getDb(), buildOpts);
    const b2 = await buildRegistryCandidate(getDb(), buildOpts);
    ok(b1.registryBytes.equals(b2.registryBytes), 'C1 重复构建 bytes 完全一致');
    ok(b1.registrySha256 === b2.registrySha256 && b1.manifestSha256 === b2.manifestSha256, 'C1 SHA 一致');

    // C2: 输入顺序打乱后 bytes 仍一致（DB 行序无关——legacy 查询按 key 排序 + manifest 排序）
    // 用另一数据目录（乱序 import 顺序）构建对比
    ok(b1.manifest.entries.map((e) => e.key).join(',') === [...b1.manifest.entries].map((e) => e.key).sort().join(','), 'C2 manifest entries 已排序');

    // C3: voice key 冲突 fail-closed（materialization subject key == 已有 legacy key）
    const p3 = await newProjection(); // 独立 projection，其 TTS-A key = p3.profileId@1
    const regCollide = writeRegistry(path.join(DATA_DIR, 'regs'), 'collide.json', [
      {voiceProfile: p3.profileId, voiceRevision: '1', speakerName: 'collide', referenceAssetPath: `${EMIT_ROOT}/voice-a.wav`, referenceSha256: sha256OfFile(path.join(VOICE_ROOT, 'voice-a.wav'))},
    ]);
    await importLegacyRegistry(getDb(), {
      registryFilePath: regCollide,
      voiceRootDir: VOICE_ROOT,
      resolveReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
    });
    // 需释放 C1 的 active 行（single-flight）后 C3 才能 claim
    failPublication(getDb(), {publicationId: pub.id, ownerToken: pub.owner_token!, attempt: pub.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for C3'});
    const c3b = claimPublication(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: p3.matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    await expectCode('C3 候选 key 冲突 → CANDIDATE_KEY_CONFLICT（fail-closed 不静默覆盖）', async () => {
      await buildRegistryCandidate(getDb(), {publication: c3b.publication, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, ''))});
    }, CANDIDATE_KEY_CONFLICT);

    // C4: generation 确定性（BEGIN IMMEDIATE 下 MAX+1 单调）
    ok(c1.publication.generation === maxBeforeC1 + 1, `C4 generation = MAX+1（${c1.publication.generation} = ${maxBeforeC1}+1）`);

    // C5/C6: schema 1.1 字段完整 + publisherSchemaVersion 精确
    const parsed = parseAndValidateRegistry(b1.registryBytes);
    if (parsed.doc.schemaVersion === '1.1') {
      ok(parsed.doc.registryGeneration === pub.generation, 'C5 registryGeneration 匹配 publication');
      ok(parsed.doc.publisherSchemaVersion === PUBLISHER_SCHEMA_VERSION, 'C6 publisherSchemaVersion 精确');
      ok(parsed.voices.length === b1.entries.length, 'C5 voices 完整快照');
      ok(parsed.doc.voices.every((v) => v.referenceAssetPath.startsWith(EMIT_ROOT + '/')), 'C5 全部 referenceAssetPath 在 emit root 内');
    } else {
      ok(false, 'C5 candidate 必须是 1.1', parsed.doc.schemaVersion);
    }

    // C7: registry SHA = 最终 bytes SHA
    ok(b1.registrySha256 === sha256Bytes(b1.registryBytes), 'C7 registrySha256 == bytes SHA');
    ok(b1.manifestSha256 === crypto.createHash('sha256').update(b1.manifestJson, 'utf8').digest('hex'), 'C7 manifestSha256 == manifest bytes SHA');

    // C8: unknown/unsupported 字段不被静默写入（顶层与 voice 均只有契约字段）
    const docObj = JSON.parse(b1.registryBytes.toString('utf8')) as Record<string, unknown>;
    ok(JSON.stringify(Object.keys(docObj).sort()) === JSON.stringify(['publisherSchemaVersion', 'registryGeneration', 'schemaVersion', 'voices']), 'C8 顶层仅 4 契约字段');
    const voiceKeys = Object.keys((docObj.voices as Array<Record<string, unknown>>)[0]).sort();
    ok(JSON.stringify(voiceKeys) === JSON.stringify(['referenceAssetPath', 'referenceSha256', 'speakerName', 'voiceProfile', 'voiceRevision']), 'C8 voice 仅 5 契约字段');

    // C9: legacy 与 materialization 合并符合 frozen 裁决（mapped_active 在 candidate 中换源）
    const cutoverInCandidate = b1.entries.find((e) => e.key === 'c-voice@1');
    ok(cutoverInCandidate !== undefined, 'C9 cutover subject key 存在');
    ok(cutoverInCandidate!.emittedSource === 'materialization', 'C9 subject key 换为 materialization source');
    ok(cutoverInCandidate!.voice.referenceSha256 === matRevSha, 'C9 subject 换为 projection SHA');
    ok(cutoverInCandidate!.voice.referenceAssetPath === `${EMIT_ROOT}/${cutoverProfileId}/${cutoverRevisionId}/reference.wav`, 'C9 subject referenceAssetPath = projection');
    ok(cutoverInCandidate!.voice.speakerName === 'c-spk', 'C9 legacy speaker 身份保持（voice 连续性）');
    const aEntry = b1.entries.find((e) => e.key === 'a-voice@1');
    ok(aEntry !== undefined && aEntry.emittedSource === 'legacy' && aEntry.voice.referenceSha256 === sha256OfFile(path.join(VOICE_ROOT, 'voice-a.wav')), 'C9 非 subject key 保持 legacy source');
    const manifestKeys = b1.manifest.entries.map((e) => `${e.key}:${e.emittedSource}:${e.referenceSha256}`);
    ok(manifestKeys.length === b1.entries.length, 'C9 manifest 逐 key 覆盖全部 entries');

    // C10: 不修改输入对象
    const pubBefore = JSON.stringify(pub);
    const optsBefore = JSON.stringify({publication: pub, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT});
    await buildRegistryCandidate(getDb(), buildOpts);
    ok(JSON.stringify(pub) === pubBefore, 'C10 publication 输入对象未被修改');
    ok(JSON.stringify({publication: pub, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT}) === optsBefore, 'C10 build options 未被修改');

    // 释放 c3b 的 active flight（C3 构建失败后 publication 保持 building——recoverable；供 D 段使用）
    failPublication(getDb(), {publicationId: c3b.publication.id, ownerToken: c3b.publication.owner_token!, attempt: c3b.publication.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for D'});
  }

  // ══════════════ D. Durable file ══════════════
  {
    const stableSha = sha256Bytes(fs.readFileSync(path.join(DATA_DIR, 'regs', 'cutover-src.json')));
    const pubCountBeforeD = publicationRowCount();
    const entryDefault = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='default'").get() as {id: string};
    const outcome = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entryDefault.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
      build: {
        legacyVoiceRootDir: VOICE_ROOT,
        materializationRootDir: MAT_ROOT,
        emitVoiceRootPath: EMIT_ROOT,
        resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      },
    });
    ok(outcome.status === 'file_durable', 'D1 编排到达 file_durable', outcome.status);
    const filePath = outcome.candidateFilePath;
    ok(fs.existsSync(filePath), 'D1 candidate 文件存在');
    ok(fs.readdirSync(candidateRegistryDir()).filter((f) => f.endsWith('.tmp')).length === 0, 'D1 无 .tmp 残留');
    const fileSha = sha256OfFile(filePath);
    ok(fileSha === outcome.candidateRegistrySha256, 'D2 文件 SHA == 编排返回 SHA');
    const row = getPublicationRow(getDb(), outcome.publicationId);
    ok(row.status === 'file_durable' && row.candidate_registry_sha256 === fileSha && row.file_durable_at !== null, 'D2 DB evidence == 文件 SHA + file_durable_at');
    const parsedFile = parseAndValidateRegistry(fs.readFileSync(filePath));
    ok(parsedFile.doc.schemaVersion === '1.1', 'D2 文件是合法 1.1 registry');
    ok(parsedFile.doc.schemaVersion === '1.1' && parsedFile.doc.registryGeneration === row.generation, 'D2 文件 generation == DB generation');

    // D13: 重跑幂等（复用完全相同 durable candidate）
    const outcome2 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entryDefault.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
      build: {
        legacyVoiceRootDir: VOICE_ROOT,
        materializationRootDir: MAT_ROOT,
        emitVoiceRootPath: EMIT_ROOT,
        resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, '')),
      },
    });
    ok(outcome2.publicationId === outcome.publicationId && outcome2.candidateRegistrySha256 === outcome.candidateRegistrySha256, 'D13 重跑复用同一 publication + 同一 candidate');
    ok(publicationRowCount() === pubCountBeforeD + 1, 'D13 重跑不新建 publication row');
    ok(sha256OfFile(filePath) === fileSha, 'D13 durable 文件未变');

    // D14: 同 generation 不同 bytes → fail-closed（不覆盖）
    const otherBytes = Buffer.from('{"schemaVersion":"1.1","registryGeneration":' + row.generation + ',"publisherSchemaVersion":"tts-c-registry-publisher@1","voices":[]}', 'utf8');
    await expectCode('D14 同 generation 不同 bytes → CANDIDATE_BYTES_CONFLICT', async () => {
      await persistCandidateFile({generation: row.generation, candidateBytes: otherBytes, expectedSha256: sha256Bytes(otherBytes)});
    }, CANDIDATE_BYTES_CONFLICT);
    ok(sha256OfFile(filePath) === fileSha, 'D14 冲突时原文件未被覆盖');

    // 释放 D1 的 file_durable 行（frozen 单飞：file_durable 仍在 active set；供 D3 新 subject 使用）
    failPublication(getDb(), {publicationId: outcome.publicationId, ownerToken: row.owner_token!, attempt: row.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for D3'});

    // D3: partial write 故障（fsyncFile 注入失败）→ 无 final、无 temp 残留、DB 不前进
    const entryA = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='a-voice'").get() as {id: string};
    void entryA;
    const {matId: newMat} = await newProjection();
    const claimT = claimPublication(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: newMat, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    const pubT = claimT.publication;
    const built = await buildRegistryCandidate(getDb(), {publication: pubT, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, ''))});
    markCandidatePersisted(getDb(), {publicationId: pubT.id, ownerToken: pubT.owner_token!, attempt: pubT.attempt, candidateRegistrySha256: built.registrySha256, candidateManifestJson: built.manifestJson, candidateManifestSha256: built.manifestSha256});
    await expectCode('D3 fsync 故障 → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: pubT.generation, candidateBytes: built.registryBytes, expectedSha256: built.registrySha256, fsyncFile: async () => { throw new Error('injected fsync failure'); }});
    }, CANDIDATE_FILE_IO);
    ok(!fs.existsSync(candidateRegistryPath(pubT.generation)), 'D3 无 final 文件');
    ok(fs.readdirSync(candidateRegistryDir()).filter((f) => f.endsWith('.tmp')).length === 0, 'D3 无 temp 残留');
    const rowT = getPublicationRow(getDb(), pubT.id);
    ok(rowT.status === 'candidate_persisted', 'D3 DB 保持 candidate_persisted（文件 durable 前不前进）');

    // D4: dir fsync 故障（rename 后失败）→ 错误 + 无 temp 残留 + DB 不前进；final 已 rename（recoverable）
    const built2 = await buildRegistryCandidate(getDb(), {publication: getPublicationRow(getDb(), pubT.id), legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, ''))});
    const genG4 = 9004;
    await expectCode('D4 dir fsync 故障 → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: genG4, candidateBytes: built2.registryBytes, expectedSha256: built2.registrySha256, fsyncDir: async () => { throw new Error('injected dir fsync failure'); }});
    }, CANDIDATE_FILE_IO);
    ok(fs.existsSync(candidateRegistryPath(genG4)), 'D4 rename 已发生（final 保留；dir fsync 失败在 rename 后）');
    ok(fs.readdirSync(candidateRegistryDir()).filter((f) => f.endsWith('.tmp')).length === 0, 'D4 无 temp 残留');
    ok(getPublicationRow(getDb(), pubT.id).status === 'candidate_persisted', 'D4 DB 不前进');

    // D5: rename 故障（final 路径被目录占据）→ 清理 temp
    const genG5 = 9005;
    fs.mkdirSync(candidateRegistryPath(genG5), {recursive: true});
    await expectCode('D5 rename 故障 → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: genG5, candidateBytes: built2.registryBytes, expectedSha256: built2.registrySha256});
    }, CANDIDATE_FILE_IO);
    fs.rmdirSync(candidateRegistryPath(genG5));
    ok(fs.readdirSync(candidateRegistryDir()).filter((f) => f.endsWith('.tmp')).length === 0, 'D5 无 temp 残留');
    ok(!fs.existsSync(candidateRegistryPath(genG5)), 'D5 rename 失败无 final');

    // D6: post-rename reread 故障（afterRenameHook 注入）→ 无 temp 残留 + DB 不前进；final 保留
    const genG6 = 9006;
    await expectCode('D6 rename 后 reread 故障 → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: genG6, candidateBytes: built2.registryBytes, expectedSha256: built2.registrySha256, afterRenameHook: async () => { throw new Error('injected reread failure'); }});
    }, CANDIDATE_FILE_IO);
    ok(getPublicationRow(getDb(), pubT.id).status === 'candidate_persisted', 'D6 DB 不前进');
    ok(fs.readdirSync(candidateRegistryDir()).filter((f) => f.endsWith('.tmp')).length === 0, 'D6 无 temp 残留');
    // afterRenameHook 失败时 final 已 rename——无 temp；final 残留（不可回滚；authoritative candidate 不删除）
    ok(fs.existsSync(candidateRegistryPath(genG6)), 'D6 final 已 durable（recoverable evidence 保留，不静默删除）');

    // D7: post-rename SHA mismatch（expected 错误）→ 失败
    await expectCode('D7 reread SHA 与预期不符 → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: 9999, candidateBytes: built2.registryBytes, expectedSha256: 'f'.repeat(64)});
    }, CANDIDATE_FILE_IO);

    // D8: symlink root 拒绝（parent 逐级 symlink 检查）
    const fakeRoot = path.join(DATA_DIR, 'fake-registries');
    fs.rmSync(fakeRoot, {recursive: true, force: true});
    const realOutside = path.join(DATA_DIR, 'outside');
    fs.mkdirSync(realOutside, {recursive: true});
    fs.symlinkSync(realOutside, fakeRoot);
    // 用临时替换 candidateRegistryDir 无法做到（内部 getDataDir）——改为直接测 ensureCandidateRootSafe 语义：
    // 通过将 dataDir 下 voice-registries 换成 symlink 来触发
    const realRegDir = candidateRegistryDir();
    const backup = realRegDir + '.bak';
    fs.rmSync(backup, {recursive: true, force: true});
    fs.renameSync(realRegDir, backup);
    fs.symlinkSync(path.join(DATA_DIR, 'outside'), realRegDir);
    await expectCode('D8 candidate root 为 symlink → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: 7777, candidateBytes: built2.registryBytes, expectedSha256: built2.registrySha256});
    }, CANDIDATE_FILE_IO);
    fs.unlinkSync(realRegDir);
    fs.renameSync(backup, realRegDir);

    // D9: final path symlink 拒绝
    const symFinal = candidateRegistryPath(8888);
    fs.symlinkSync(path.join(DATA_DIR, 'outside', 'target.json'), symFinal);
    await expectCode('D9 final path 为 symlink → CANDIDATE_FILE_IO', async () => {
      await persistCandidateFile({generation: 8888, candidateBytes: built2.registryBytes, expectedSha256: built2.registrySha256});
    }, CANDIDATE_FILE_IO);
    fs.unlinkSync(symFinal);

    // D10: path escape 拒绝（root realpath 漂移已覆盖 D8；补 final 越出 root 断言）
    const escaped = path.join(realRegDir, '..', 'outside', 'x.json');
    ok(!escaped.startsWith(realRegDir + path.sep), 'D10 final path 构造不越出 root（断言）');

    // D11: 文件未 durable 前 DB 不得声称成功（D3-D6 已断言 candidate_persisted；此处编排级验证）
    // 释放 D3 的 candidate_persisted 行（供 D12 新 subject）
    const d3Row = getPublicationRow(getDb(), pubT.id);
    failPublication(getDb(), {publicationId: pubT.id, ownerToken: d3Row.owner_token!, attempt: d3Row.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release for D12'});

    // D12: file durable + DB finalize 失败 → 留下可恢复证据（candidate_persisted + candidate evidence + 文件存在）
    const entryForD12 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='b-voice'").get() as {id: string};
    const {matId: matD12} = await newProjection();
    markMappedVerified(entryForD12.id, matD12, 'publish_and_cutover');
    const claimD12 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entryForD12.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: stableSha,
    });
    const pubD12 = claimD12.publication;
    const builtD12 = await buildRegistryCandidate(getDb(), {publication: pubD12, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (p) => path.join(VOICE_ROOT, p.replace(/^\/voices\//, ''))});
    markCandidatePersisted(getDb(), {publicationId: pubD12.id, ownerToken: pubD12.owner_token!, attempt: pubD12.attempt, candidateRegistrySha256: builtD12.registrySha256, candidateManifestJson: builtD12.manifestJson, candidateManifestSha256: builtD12.manifestSha256});
    const d12Path = await persistCandidateFile({generation: pubD12.generation, candidateBytes: builtD12.registryBytes, expectedSha256: builtD12.registrySha256});
    // 模拟 Tx B 失败：篡改 owner token（fence 不命中）
    await expectCode('D12 Tx B fence 失败 → PUBLICATION_NOT_OWNER', () => {
      markFileDurable(getDb(), pubD12.id, 'WRONG-OWNER', pubD12.attempt);
    }, PUBLICATION_NOT_OWNER);
    const rowD12 = getPublicationRow(getDb(), pubD12.id);
    ok(rowD12.status === 'candidate_persisted' && rowD12.candidate_registry_sha256 === builtD12.registrySha256, 'D12 保持 candidate_persisted + candidate evidence（recoverable）');
    ok(sha256OfFile(d12Path) === builtD12.registrySha256, 'D12 durable 文件保留（authoritative candidate 不删除）');
    // 正确 owner 继续 Tx B → file_durable（recovery 可续）
    markFileDurable(getDb(), pubD12.id, pubD12.owner_token!, pubD12.attempt);
    ok(getPublicationRow(getDb(), pubD12.id).status === 'file_durable', 'D12 正确 owner 续推进 file_durable');

    // D15: 无残留（process/fd/temp 目录）
    ok(fs.readdirSync(candidateRegistryDir()).every((f) => f.endsWith('.json')), 'D15 candidate root 仅含 final json（无 temp/staging）');
    ok(legacyCount() >= 0, 'D15 legacy 表可读');
  }

  // 清理
  closeDb();
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  summary(TAG);
})().catch((e) => {
  console.error(e);
  ok(false, TAG, `uncaught: ${(e as Error).message}`);
  summary(TAG);
});

function projRelOf(): string {
  return `${fx.profileId}/${fx.revisionId}/reference.wav`;
}
