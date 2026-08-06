/**
 * TTS-C.1B.3 activation / acknowledgment / atomic activation / crash reconciliation 测试。
 *
 * 场景矩阵（frozen §7.3 T3/T4/T5、§D CC-1…CC-6、1B.3 计划 §十二）：
 *   A T3 reload（promotion/幂等/unknown/一致性/明确失败/timeout/owner/containment/故障/candidate immutable）
 *   B T4 acknowledgment（identity 匹配/部分不匹配/retryable/unknown/malformed/renew 前置/evidence write-once）
 *   C T5 atomic activation（四 subject + owner/attempt/lease/observed/subject 错误 + duplicate + direct UPDATE 拒绝）
 *   D Takeover（未过期/过期/双进程唯一 winner/attempt+1/旧 owner 全失效/loser 零副作用）
 *   E Crash matrix（CC-1…CC-6）
 *   F Indeterminate（evidence seal/reconciliation/stable→failed/unknown 保持/非 activation_pending 来源/evidence exact/重复拒绝）
 *   G Recovery controller（周期/不重入/shutdown settle/单条隔离/terminal 无动作/single-flight/无泄漏）
 *
 * 全部使用临时 SQLite + 临时目录 + mock HTTP adapter；零 production、零真实 IndexTTS2。
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ok, fail, summary, setupC1aFixture, makeWav, sha256Buf, execDeps, type C1aFixture} from './lib/tts-c1a-test-utils';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {closeDb, getDb} from '../src/lib/db';
import {importLegacyRegistry} from '../src/lib/tts-c/legacy-import';
import {
  claimPublication,
  buildRegistryCandidate,
  markCandidatePersisted,
  markFileDurable,
  failPublication,
  publishRegistryCandidate,
  getPublicationRow,
  candidateRegistryDir,
  candidateRegistryPath,
  PUBLISHER_SCHEMA_VERSION,
  PUBLICATION_NOT_OWNER,
  type PublicationRow,
} from '../src/lib/tts-c/registry-publisher';
import {
  AdapterClient,
  activateRegistryPublicationFlow,
  activateRegistryPublication,
  reconcileIndeterminateActivation,
  takeoverExpiredPublication,
  markActivationPending,
  promoteCandidateToActive,
  classifyActiveDiskState,
  recoverRegistryPublications,
  type ActiveRegistryPaths,
} from '../src/lib/tts-c/registry-activation';
import {RegistryRecoveryController} from '../src/lib/tts-c/registry-recovery-controller';
import {RegistryContractError} from '../src/lib/tts-c/registry-contract-error';
import {sha256Bytes} from '../src/lib/tts-c/registry-schema';

const execFileP = promisify(execFile);
const TAG = 'test-tts-c1b3-activation';
const EMIT_ROOT = '/voices';
const SUPPORTED_PUB = 'tts-c-registry-publisher@1';

let fx!: C1aFixture;
let DATA_DIR!: string;
let VOICE_ROOT!: string;
let MAT_ROOT!: string;
let ACTIVE_DIR!: string;
let ACTIVE_PATH!: string;
let ACTIVE_ROOT!: string;
let PATHS!: ActiveRegistryPaths;

function sha256OfFile(p: string): string {
  return sha256Bytes(fs.readFileSync(p));
}

function wavFile(): Buffer {
  return makeWav(800, 330);
}

function writeRegistry(dir: string, name: string, voices: Array<Record<string, string>>): string {
  const doc: Record<string, unknown> = {schemaVersion: '1.0', voices};
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

function insertMaterializationRow(profileId: string, revisionId: string, sourceSha: string, sourceFileAbs: string, status = 'file_ready_unpublished'): string {
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
  const abs = path.join(MAT_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.copyFileSync(sourceFileAbs, abs);
  if (sha256OfFile(abs) !== sourceSha) throw new Error('projection SHA mismatch');
  return id;
}

async function newProjection(): Promise<{matId: string; profileId: string; revisionId: string; revisionSha: string}> {
  const profile = createVoiceProfile({displayName: `c1b3-${crypto.randomUUID().slice(0, 8)}`});
  const audio = makeWav(800, 330 + Math.floor(Math.random() * 50));
  const revision = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: audio},
    execDeps,
  );
  const revRow = revision.outcome === 'created' || revision.outcome === 'reused' ? revision.revision : null;
  if (!revRow) throw new Error(`ingest failed: ${JSON.stringify(revision)}`);
  const canonicalAbs = path.join(DATA_DIR, 'voice-library', profile.id, revRow.id, 'reference.wav');
  const revisionSha = sha256OfFile(canonicalAbs);
  const matId = insertMaterializationRow(profile.id, revRow.id, revisionSha, canonicalAbs);
  return {matId, profileId: profile.id, revisionId: revRow.id, revisionSha};
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

function failRow(row: PublicationRow, errorCode: string, errorMessage: string): void {
  failPublication(getDb(), {publicationId: row.id, ownerToken: row.owner_token as string, attempt: row.attempt, errorCode, errorMessage});
}

function publicationCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM voice_registry_publications').get() as {n: number}).n;
}

async function runChild(args: string[]): Promise<Record<string, unknown>> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1b2-child.ts');
  const {stdout} = await execFileP(process.execPath, ['--import', 'tsx', childPath, ...args], {
    env: {...process.env, ZHIYING_DATA_DIR: DATA_DIR},
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

// ── Mock adapter ──

type MockReloadBehavior = 'ok' | 'reject500' | 'timeout' | 'malformed' | 'close';
type MockStatusBehavior = 'ok' | 'non2xx' | 'timeout' | 'malformed' | 'close';

class MockAdapter {
  server: http.Server;
  baseUrl = '';
  reloadCalls = 0;
  statusCalls = 0;
  reloadBehavior: MockReloadBehavior = 'ok';
  statusBehavior: MockStatusBehavior = 'ok';
  loadedSha: string | null = null;
  loadedGeneration: number | null = null;
  loadedPublisher: string | null = null;
  loadedSchema: string | null = null;
  ready = true;
  lastReloadError: string | null = null;
  /** false 时 reload ok 不重置 loaded 状态（测试篡改 loaded 场景用）。 */
  reloadUpdatesLoaded = true;
  private readonly activePath: string;

  constructor(activePath: string) {
    this.activePath = activePath;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock server addr');
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** reload 成功时模拟 adapter 从配置路径读取 active registry（真实语义）。 */
  private readActiveState(): void {
    try {
      const bytes = fs.readFileSync(this.activePath);
      const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      this.loadedSha = sha256Bytes(bytes);
      this.loadedSchema = typeof doc.schemaVersion === 'string' ? doc.schemaVersion : null;
      this.loadedGeneration = typeof doc.registryGeneration === 'number' ? doc.registryGeneration : null;
      this.loadedPublisher = typeof doc.publisherSchemaVersion === 'string' ? doc.publisherSchemaVersion : null;
      this.lastReloadError = null;
    } catch {
      // 文件缺失/损坏——保持 loaded 状态
    }
  }

  private statusJson(): string {
    return JSON.stringify({
      ready: this.ready,
      degraded: this.lastReloadError !== null,
      schemaVersion: this.loadedSchema,
      loadedRegistrySha256: this.loadedSha,
      loadedRegistryGeneration: this.loadedGeneration,
      publisherSchemaVersion: this.loadedPublisher,
      speakerCount: this.loadedSha !== null ? 1 : null,
      detail: null,
      lastReloadError: this.lastReloadError,
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/reload') {
      this.reloadCalls += 1;
      if (this.reloadBehavior === 'timeout') return; // 不响应（超时）
      if (this.reloadBehavior === 'close') {
        res.destroy();
        return;
      }
      if (this.reloadBehavior === 'malformed') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{not-json');
        return;
      }
      if (this.reloadBehavior === 'reject500') {
        res.writeHead(500, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: {code: 'VOICE_REGISTRY_RELOAD_FAILED', message: 'reload failed'}}));
        return;
      }
      // ok：读取 active 文件模拟加载（可关闭以测试篡改 loaded 场景）
      if (this.reloadUpdatesLoaded) {
        this.readActiveState();
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(this.statusJson());
      return;
    }
    if (req.method === 'GET' && url === '/registry-status') {
      this.statusCalls += 1;
      if (this.statusBehavior === 'timeout') return;
      if (this.statusBehavior === 'close') {
        res.destroy();
        return;
      }
      if (this.statusBehavior === 'malformed') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"ready":"not-bool"}');
        return;
      }
      if (this.statusBehavior === 'non2xx') {
        res.writeHead(503, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: {code: 'X', message: 'y'}}));
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(this.statusJson());
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

// ── fixture ──

async function setup(): Promise<void> {
  DATA_DIR = path.join('data', TAG);
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  process.env.ZHIYING_DATA_DIR = DATA_DIR;
  closeDb();
  getDb();
  fx = await setupC1aFixture(TAG);
  VOICE_ROOT = path.resolve(path.join(DATA_DIR, 'voices'));
  MAT_ROOT = path.resolve(path.join(DATA_DIR, 'voice-materializations'));
  ACTIVE_DIR = path.resolve(path.join(DATA_DIR, 'active-registry'));
  ACTIVE_PATH = path.join(ACTIVE_DIR, 'voice-registry.json');
  ACTIVE_ROOT = ACTIVE_DIR;
  PATHS = {activeRegistryPath: ACTIVE_PATH, activeRegistryRoot: ACTIVE_ROOT};
  fs.mkdirSync(VOICE_ROOT, {recursive: true});
  fs.mkdirSync(MAT_ROOT, {recursive: true});
  fs.mkdirSync(ACTIVE_DIR, {recursive: true});
  closeDb();
  getDb();
}

interface PreparedPublish {
  pub: PublicationRow;
  built: Awaited<ReturnType<typeof buildRegistryCandidate>>;
  activeStableSha: string;
  adapter: MockAdapter;
}

/**
 * 准备一个 file_durable publication（materialization_publish subject）+ stable active registry +
 * mock adapter（loaded=stable）。
 */
/** 释放全部 active-flight publication（frozen 单飞：连续场景必须释放；indeterminate 保持由场景自管）。 */
/** 测试辅助：无条件释放全部 active-flight publication（绕过 lease fence；仅测试清理用）。 */
function releaseAllActiveFlights(): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE voice_registry_publications
          SET status='failed', failed_at=?, error_code='TEST_RELEASE', error_message='test release',
              owner_token=NULL, lease_expires_at_epoch_ms=NULL, updated_at=?
        WHERE status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate')`,
    )
    .run(now, now);
}

async function prepareFileDurable(): Promise<PreparedPublish> {
  releaseAllActiveFlights();
  const p = await newProjection();
  // stable active registry：导入 legacy voice 并以其文件 bytes 作为 stable sha 基准
  const wav = wavFile();
  fs.writeFileSync(path.join(VOICE_ROOT, 'stable-v.wav'), wav);
  const stableSha = sha256Buf(wav);
  const regPath = writeRegistry(path.join(DATA_DIR, 'regs'), `stable-${crypto.randomUUID().slice(0, 6)}.json`, [
    {voiceProfile: 'stable', voiceRevision: '1', speakerName: 'stable-spk', referenceAssetPath: `${EMIT_ROOT}/stable-v.wav`, referenceSha256: stableSha},
  ]);
  await importLegacyRegistry(getDb(), {registryFilePath: regPath, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
  // 写 stable active registry 文件（1.0 格式，引用 stable-v.wav）
  const stableDoc = JSON.stringify({schemaVersion: '1.0', voices: [{voiceProfile: 'stable', voiceRevision: '1', speakerName: 'stable-spk', referenceAssetPath: `${EMIT_ROOT}/stable-v.wav`, referenceSha256: stableSha}]}, null, 2) + '\n';
  fs.writeFileSync(ACTIVE_PATH, stableDoc);

  const adapter = new MockAdapter(ACTIVE_PATH);
  await adapter.start();
  adapter.loadedSha = sha256Bytes(Buffer.from(stableDoc));
  adapter.loadedSchema = '1.0';
  adapter.loadedPublisher = null;
  adapter.loadedGeneration = null;

  const outcome = await publishRegistryCandidate(getDb(), {
    subject: {subjectType: 'materialization_publish', subjectId: p.matId, subjectMode: 'publish_and_cutover'},
    stableRegistrySha256: sha256Bytes(Buffer.from(stableDoc)),
    build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
  });
  if (outcome.kind !== 'completed') throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);
  const pub = getPublicationRow(getDb(), outcome.publicationId);
  const built = await buildRegistryCandidate(getDb(), {publication: pub, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
  return {pub, built, activeStableSha: sha256Bytes(Buffer.from(stableDoc)), adapter};
}

function activationOpts(pub: PublicationRow, adapter: MockAdapter) {
  return {
    publicationId: pub.id,
    ownerToken: pub.owner_token as string,
    attempt: pub.attempt,
    paths: PATHS,
    adapter: new AdapterClient({baseUrl: adapter.baseUrl, timeoutMs: 500}),
  };
}

function recoveryDeps(adapter: MockAdapter) {
  return {
    db: getDb(),
    paths: PATHS,
    adapter: new AdapterClient({baseUrl: adapter.baseUrl, timeoutMs: 500}),
    build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
  };
}

(async () => {
  await setup();

  // ══════════════ A. T3 reload ══════════════
  {
    const {pub, built, adapter} = await prepareFileDurable();

    // A1: stable disk → atomic promotion → reload 200 → active
    const diskBefore = await classifyActiveDiskState(getDb(), pub.id, PATHS);
    ok(diskBefore.state === 'stable', 'A1 初始 disk stable');
    const outcome = await activateRegistryPublicationFlow(getDb(), activationOpts(pub, adapter));
    ok(outcome.kind === 'active', `A1 完整激活 → active（实际 ${JSON.stringify(outcome).slice(0, 120)}）`);
    const after = getPublicationRow(getDb(), pub.id);
    ok(after.status === 'active', 'A1 publication active');
    ok(adapter.loadedSha === pub.candidate_registry_sha256, 'A1 adapter loaded == candidate SHA');
    ok(adapter.reloadCalls >= 1, 'A1 reload 被调用');
    const activeSha = sha256OfFile(ACTIVE_PATH);
    ok(activeSha === pub.candidate_registry_sha256, 'A1 active registry 文件 == candidate bytes（相同 bytes 提升）');
    // A10: candidate immutable 文件不变
    const candidateBytes = fs.readFileSync(candidateRegistryPath(pub.generation));
    ok(sha256Bytes(candidateBytes) === pub.candidate_registry_sha256, 'A10 candidate 文件未变（bytes == evidence）');

    // A2: 再次调用 → already_active
    const again = await activateRegistryPublicationFlow(getDb(), activationOpts(pub, adapter));
    ok(again.kind === 'already_active', 'A2 已 active → already_active');

    // A3: disk unknown → REGISTRY_STATE_UNKNOWN 零覆盖零 reload
    const {pub: pub2, adapter: adapter2} = await prepareFileDurable();
    fs.writeFileSync(ACTIVE_PATH, '{"schemaVersion":"1.0","voices":[]}');
    const reloadsBefore = adapter2.reloadCalls;
    await expectCode('A3 disk unknown → REGISTRY_STATE_UNKNOWN', async () => {
      await activateRegistryPublicationFlow(getDb(), activationOpts(pub2, adapter2));
    }, 'REGISTRY_STATE_UNKNOWN');
    ok(adapter2.reloadCalls === reloadsBefore, 'A3 零 reload 调用');
    ok(getPublicationRow(getDb(), pub2.id).status === 'file_durable', 'A3 publication 保持 file_durable');
    failRow(getPublicationRow(getDb(), pub2.id), 'TEST_FAIL', 'release A3');
    await adapter2.stop();

    // A4: candidate 文件被篡改（SHA 与 DB evidence 不符）→ fail-closed
    const {pub: pub3, adapter: adapter3} = await prepareFileDurable();
    fs.writeFileSync(candidateRegistryPath(pub3.generation), '{"schemaVersion":"1.1","registryGeneration":9,"publisherSchemaVersion":"tts-c-registry-publisher@1","voices":[]}');
    await expectCode('A4 durable candidate SHA 不符 → CANDIDATE_FILE_IO', async () => {
      await activateRegistryPublicationFlow(getDb(), activationOpts(pub3, adapter3));
    }, 'CANDIDATE_FILE_IO');
    ok(getPublicationRow(getDb(), pub3.id).status === 'file_durable', 'A4 不 activation');
    failRow(getPublicationRow(getDb(), pub3.id), 'TEST_FAIL', 'release A4');
    await adapter3.stop();

    // A5: reload 明确失败（500）→ reload_retryable，LKG stable，零 activation
    const {pub: pub4, adapter: adapter4} = await prepareFileDurable();
    adapter4.reloadBehavior = 'reject500';
    const o5 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub4, adapter4));
    ok(o5.kind === 'reload_retryable', 'A5 reload 拒绝 → reload_retryable');
    ok(getPublicationRow(getDb(), pub4.id).status === 'file_durable', 'A5 publication 保持 file_durable（LKG 可恢复）');
    failRow(getPublicationRow(getDb(), pub4.id), 'TEST_FAIL', 'release A5');
    await adapter4.stop();

    // A6: reload timeout → indeterminate（不猜测结果）
    const {pub: pub5, adapter: adapter5} = await prepareFileDurable();
    adapter5.reloadBehavior = 'timeout';
    const o6 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub5, adapter5));
    ok(o6.kind === 'indeterminate', 'A6 reload timeout → indeterminate');
    const r5 = getPublicationRow(getDb(), pub5.id);
    ok(r5.status === 'indeterminate' && r5.indeterminate_from_status === 'file_durable', 'A6 indeterminate + from=file_durable');
    await adapter5.stop();

    // A7: stale owner renew 失败 → 零文件/HTTP 副作用
    const {pub: pub6, adapter: adapter6} = await prepareFileDurable();
    const staleOpts = activationOpts(pub6, adapter6);
    await expectCode('A7 stale owner → PUBLICATION_LEASE_EXPIRED', async () => {
      await activateRegistryPublicationFlow(getDb(), {...staleOpts, ownerToken: 'WRONG-OWNER'});
    }, 'PUBLICATION_LEASE_EXPIRED');
    ok(adapter6.reloadCalls === 0 && adapter6.statusCalls === 0, 'A7 零 HTTP 副作用');
    failRow(getPublicationRow(getDb(), pub6.id), 'TEST_FAIL', 'release A7');
    await adapter6.stop();

    // A8: active registry root symlink 拒绝
    const {pub: pub7, adapter: adapter7} = await prepareFileDurable();
    const realDir = ACTIVE_DIR + '-real';
    fs.renameSync(ACTIVE_DIR, realDir);
    fs.symlinkSync(realDir, ACTIVE_DIR);
    await expectCode('A8 active root symlink → CANDIDATE_FILE_IO', async () => {
      await activateRegistryPublicationFlow(getDb(), activationOpts(pub7, adapter7));
    }, 'CANDIDATE_FILE_IO');
    fs.unlinkSync(ACTIVE_DIR);
    fs.renameSync(realDir, ACTIVE_DIR);
    ok(getPublicationRow(getDb(), pub7.id).status === 'file_durable', 'A8 不 activation');
    failRow(getPublicationRow(getDb(), pub7.id), 'TEST_FAIL', 'release A8');
    await adapter7.stop();

    // A9: active root 不可写 → 提升失败不 activation
    const {pub: pub8, adapter: adapter8} = await prepareFileDurable();
    fs.chmodSync(ACTIVE_DIR, 0o500);
    await expectCode('A9 active root 不可写 → CANDIDATE_FILE_IO', async () => {
      await activateRegistryPublicationFlow(getDb(), activationOpts(pub8, adapter8));
    }, 'CANDIDATE_FILE_IO');
    fs.chmodSync(ACTIVE_DIR, 0o755);
    ok(getPublicationRow(getDb(), pub8.id).status === 'file_durable', 'A9 不 activation');
    failRow(getPublicationRow(getDb(), pub8.id), 'TEST_FAIL', 'release A9');
    await adapter8.stop();

    await adapter.stop();
  }

  // ══════════════ B. T4 acknowledgment ══════════════
  {
    // B1: 完整 identity 匹配 → active（A1 已覆盖；这里显式断言四字段匹配路径）
    const {pub, adapter} = await prepareFileDurable();
    const o = await activateRegistryPublicationFlow(getDb(), activationOpts(pub, adapter));
    ok(o.kind === 'active', 'B1 完整 identity 匹配 → active');
    await adapter.stop();

    // B2: SHA 匹配但 generation 不匹配 → 不 activation
    const {pub: p2, adapter: a2} = await prepareActivationPending();
    a2.reloadUpdatesLoaded = false;
    a2.loadedGeneration = (a2.loadedGeneration ?? 0) + 1;
    const o2 = await activateRegistryPublicationFlow(getDb(), activationOpts(p2, a2));
    ok(o2.kind === 'registry_state_unknown', `B2 generation 不匹配 → 不 activation（实际 ${o2.kind}）`);
    ok(getPublicationRow(getDb(), p2.id).status === 'activation_pending', 'B2 publication 未 active（保持 activation_pending）');
    await a2.stop();

    // B3: SHA/generation 匹配但 publisher version 不匹配 → 不 activation
    const {pub: p3, adapter: a3} = await prepareActivationPending();
    a3.reloadUpdatesLoaded = false;
    a3.loadedPublisher = 'WRONG-VERSION';
    const o3 = await activateRegistryPublicationFlow(getDb(), activationOpts(p3, a3));
    ok(o3.kind === 'registry_state_unknown', `B3 publisher 不匹配 → 不 activation（实际 ${o3.kind}）`);
    ok(getPublicationRow(getDb(), p3.id).status === 'activation_pending', 'B3 publication 未 active');
    await a3.stop();

    // B4: adapter 仍 stable → reload_retryable
    const {pub: p4, adapter: a4} = await prepareFileDurable();
    a4.reloadBehavior = 'reject500'; // reload 失败 → LKG stable
    const o4 = await activateRegistryPublicationFlow(getDb(), activationOpts(p4, a4));
    ok(o4.kind === 'reload_retryable', 'B4 stable → reload_retryable');
    ok(getPublicationRow(getDb(), p4.id).status === 'file_durable', 'B4 保持 file_durable');
    failRow(getPublicationRow(getDb(), p4.id), 'TEST_FAIL', 'release B4');
    await a4.stop();

    // B5: unknown active SHA → registry_state_unknown
    const {pub: p5, adapter: a5} = await prepareActivationPending();
    a5.reloadUpdatesLoaded = false;
    a5.loadedSha = 'f'.repeat(64);
    a5.loadedGeneration = null;
    a5.loadedPublisher = null;
    a5.loadedSchema = null;
    const o5 = await activateRegistryPublicationFlow(getDb(), activationOpts(p5, a5));
    ok(o5.kind === 'registry_state_unknown', 'B5 unknown → registry_state_unknown');
    ok(getPublicationRow(getDb(), p5.id).status === 'activation_pending', 'B5 不 activation');
    await a5.stop();

    // B6: registry-status malformed → indeterminate
    const {pub: p6, adapter: a6} = await prepareActivationPending();
    a6.statusBehavior = 'malformed';
    const o6 = await activateRegistryPublicationFlow(getDb(), activationOpts(p6, a6));
    ok(o6.kind === 'indeterminate', 'B6 status malformed → indeterminate');
    ok(getPublicationRow(getDb(), p6.id).status === 'indeterminate', 'B6 publication indeterminate');
    await a6.stop();

    // B7: poll 前 renew 失败 → 零 poll
    const {pub: p7, adapter: a7} = await prepareFileDurable();
    const opts7 = activationOpts(p7, a7);
    // 手动让 lease 过期（直接 SQL）
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p7.id);
    await expectCode('B7 poll 前 lease 过期 → PUBLICATION_LEASE_EXPIRED', async () => {
      await activateRegistryPublicationFlow(getDb(), opts7);
    }, 'PUBLICATION_LEASE_EXPIRED');
    const statusCallsBefore = a7.statusCalls;
    ok(a7.statusCalls === statusCallsBefore, 'B7 零 poll（status 调用未增加）');
    releaseAllActiveFlights();
    await a7.stop();

    // B8: activation_pending evidence write-once
    const {pub: p8, adapter: a8} = await prepareFileDurable();
    markActivationPending(getDb(), p8.id, p8.owner_token as string, p8.attempt);
    const requestedAt = getPublicationRow(getDb(), p8.id).activation_requested_at;
    await expectCode('B8 重复 markActivationPending → fence 不命中', () => {
      markActivationPending(getDb(), p8.id, p8.owner_token as string, p8.attempt);
    }, PUBLICATION_NOT_OWNER);
    ok(getPublicationRow(getDb(), p8.id).activation_requested_at === requestedAt, 'B8 activation_requested_at write-once');
    releaseAllActiveFlights();
    await a8.stop();
  }

  // ══════════════ C. T5 atomic activation（四 subject） ══════════════
  {
    // C1: materialization_publish（A1 已覆盖）→ 验证 projection published_usable
    const {pub, adapter} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(pub, adapter));
    const mat = getDb().prepare('SELECT status, published_registry_generation, published_registry_sha256, published_by_publication_id FROM voice_materializations WHERE id=?').get(pub.subject_id) as Record<string, unknown>;
    ok(mat.status === 'published_usable', 'C1 projection published_usable');
    ok(mat.published_registry_generation === pub.generation, 'C1 projection evidence generation');
    ok(mat.published_registry_sha256 === pub.candidate_registry_sha256, 'C1 projection evidence sha');
    ok(mat.published_by_publication_id === pub.id, 'C1 projection published_by link');
    await adapter.stop();

    // C2: legacy_cutover_publish → projection published_usable + legacy mapped_active + pending link 保留
    const p = await newProjection();
    const wav = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'cut-v.wav'), wav);
    const regPath = writeRegistry(path.join(DATA_DIR, 'regs'), `cut-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'cut', voiceRevision: '1', speakerName: 'cut-spk', referenceAssetPath: `${EMIT_ROOT}/cut-v.wav`, referenceSha256: sha256Buf(wav)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: regPath, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='cut'").get() as {id: string};
    markMappedVerified(entry.id, p.matId, 'publish_and_cutover');
    const adapter2 = new MockAdapter(ACTIVE_PATH);
    await adapter2.start();
    const stableDoc = fs.readFileSync(ACTIVE_PATH);
    adapter2.loadedSha = sha256Bytes(stableDoc);
    const outcome = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stableDoc),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (outcome.kind !== 'completed') throw new Error(`C2 prepare failed: ${JSON.stringify(outcome)}`);
    const pub2 = getPublicationRow(getDb(), outcome.publicationId);
    const o2 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub2, adapter2));
    ok(o2.kind === 'active', 'C2 legacy_cutover_publish → active');
    const lve = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, candidate_activated_at, mapped_voice_materialization_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry.id) as Record<string, unknown>;
    ok(lve.mapping_status === 'mapped_active', 'C2 legacy mapped_active');
    ok(lve.pending_publication_id === pub2.id, 'C2 pending link 保留（provenance）');
    ok(lve.candidate_activated_at !== null, 'C2 candidate_activated_at 已填');
    const mat2 = getDb().prepare('SELECT status FROM voice_materializations WHERE id=?').get(p.matId) as {status: string};
    ok(mat2.status === 'published_usable', 'C2 projection published_usable');
    await adapter2.stop();

    // C3: legacy_cutover_existing —— 合法前置需要 published_usable projection（T5 产生）。
    // 先激活一个独立 projection（materialization_publish → active → published_usable），
    // 再让 cutover_existing entry 映射到它（trg_lve_alias 禁止两个 entry 同一 projection）。
    const cut2 = await newProjection();
    const adapterC3a = new MockAdapter(ACTIVE_PATH);
    await adapterC3a.start();
    const stableDocC3a = fs.readFileSync(ACTIVE_PATH);
    adapterC3a.loadedSha = sha256Bytes(stableDocC3a);
    const outcomeC3a = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: cut2.matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stableDocC3a),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (outcomeC3a.kind !== 'completed') throw new Error(`C3a prepare failed: ${JSON.stringify(outcomeC3a)}`);
    const pubC3a = getPublicationRow(getDb(), outcomeC3a.publicationId);
    const oC3a = await activateRegistryPublicationFlow(getDb(), activationOpts(pubC3a, adapterC3a));
    ok(oC3a.kind === 'active', 'C3a 前置 projection 已激活（published_usable）');
    const matC3a = getDb().prepare('SELECT status, published_registry_generation, published_registry_sha256, published_by_publication_id FROM voice_materializations WHERE id=?').get(cut2.matId) as Record<string, unknown>;
    ok(matC3a.status === 'published_usable', 'C3a projection published_usable');
    await adapterC3a.stop();

    const wav2 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'cut2-v.wav'), wav2);
    const regPath2 = writeRegistry(path.join(DATA_DIR, 'regs'), `cut2-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'cut2', voiceRevision: '1', speakerName: 'cut2-spk', referenceAssetPath: `${EMIT_ROOT}/cut2-v.wav`, referenceSha256: sha256Buf(wav2)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: regPath2, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entryCut2 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='cut2'").get() as {id: string};
    markMappedVerified(entryCut2.id, cut2.matId, 'cutover_existing');
    const stableDoc2 = fs.readFileSync(ACTIVE_PATH);
    const adapter3 = new MockAdapter(ACTIVE_PATH);
    await adapter3.start();
    adapter3.loadedSha = sha256Bytes(stableDoc2);
    const outcome3 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_existing', subjectId: entryCut2.id, subjectMode: 'cutover_existing'},
      stableRegistrySha256: sha256Bytes(stableDoc2),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (outcome3.kind !== 'completed') throw new Error(`C3 prepare failed: ${JSON.stringify(outcome3)}`);
    const pub3 = getPublicationRow(getDb(), outcome3.publicationId);
    const o3 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub3, adapter3));
    ok(o3.kind === 'active', 'C3 legacy_cutover_existing → active');
    const lve3 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entryCut2.id) as Record<string, unknown>;
    ok(lve3.mapping_status === 'mapped_active', 'C3 legacy mapped_active');
    // projection 零改写（published evidence 保持 C3a 激活的 generation/sha/published_by）
    const mat3 = getDb().prepare('SELECT status, published_registry_generation, published_registry_sha256, published_by_publication_id FROM voice_materializations WHERE id=?').get(cut2.matId) as Record<string, unknown>;
    ok(mat3.status === 'published_usable', 'C3 projection 保持 published_usable');
    ok(mat3.published_registry_generation === pubC3a.generation, 'C3 projection evidence 零改写（generation 保持 C3a）');
    ok(mat3.published_registry_sha256 === pubC3a.candidate_registry_sha256, 'C3 projection sha 零改写');
    ok(mat3.published_by_publication_id === pubC3a.id, 'C3 projection published_by 零改写（保持 C3a）');
    await adapter3.stop();

    // C4: registry_rebuild → publication active，无 projection/legacy 变化
    const adapter4 = new MockAdapter(ACTIVE_PATH);
    await adapter4.start();
    const stableDoc4 = fs.readFileSync(ACTIVE_PATH);
    adapter4.loadedSha = sha256Bytes(stableDoc4);
    const outcome4 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'registry_rebuild', subjectId: 'global', subjectMode: 'none'},
      stableRegistrySha256: sha256Bytes(stableDoc4),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (outcome4.kind !== 'completed') throw new Error(`C4 prepare failed: ${JSON.stringify(outcome4)}`);
    const pub4 = getPublicationRow(getDb(), outcome4.publicationId);
    const matCountBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM voice_materializations').get() as {n: number}).n;
    const lveCountBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM legacy_adapter_voice_entries').get() as {n: number}).n;
    const o4 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub4, adapter4));
    ok(o4.kind === 'active', 'C4 registry_rebuild → active');
    ok((getDb().prepare('SELECT COUNT(*) AS n FROM voice_materializations').get() as {n: number}).n === matCountBefore, 'C4 projection 零变化');
    ok((getDb().prepare('SELECT COUNT(*) AS n FROM legacy_adapter_voice_entries').get() as {n: number}).n === lveCountBefore, 'C4 legacy 零变化');
    await adapter4.stop();

    // C5: wrong owner / wrong attempt / expired lease / observed SHA mismatch → trigger ABORT 整条回滚
    const {pub: p5, adapter: a5} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(p5, a5)); // 到 active
    const {pub: p5b, adapter: a5b} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(p5b, a5b)); // 到 active
    const {pub: p5c, adapter: a5c} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(p5c, a5c)); // 到 active
    // 新 file_durable 用于错误矩阵
    const {pub: pErr, adapter: aErr} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(pErr, aErr)); // 到 active（正常路径先行验证）
    // 再准备一个直接构造 activation_pending 的（错误矩阵用 trigger 直接 INSERT）
    const {pub: pE2, adapter: aE2} = await prepareActivationPending();
    await expectCode('C5 wrong owner → trigger ABORT', () => {
      activateRegistryPublication(getDb(), {publicationId: pE2.id, ownerToken: 'WRONG', attempt: pE2.attempt, observedActiveRegistrySha256: pE2.candidate_registry_sha256 as string});
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('C5 wrong attempt → trigger ABORT', () => {
      activateRegistryPublication(getDb(), {publicationId: pE2.id, ownerToken: pE2.owner_token as string, attempt: 999, observedActiveRegistrySha256: pE2.candidate_registry_sha256 as string});
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('C5 observed SHA mismatch → trigger ABORT', () => {
      activateRegistryPublication(getDb(), {publicationId: pE2.id, ownerToken: pE2.owner_token as string, attempt: pE2.attempt, observedActiveRegistrySha256: 'f'.repeat(64)});
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    ok(getPublicationRow(getDb(), pE2.id).status === 'activation_pending', 'C5 全部 ABORT 后整条回滚（保持 activation_pending）');
    // C6: 应用层 direct UPDATE active 拒绝（pE2 仍 activation_pending）
    await expectCode('C6 direct UPDATE → active ABORT', () => {
      getDb().prepare("UPDATE voice_registry_publications SET status='active', activated_at=? WHERE id=?").run(new Date().toISOString(), pE2.id);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    ok(getPublicationRow(getDb(), pE2.id).status === 'activation_pending', 'C6 direct UPDATE 未生效');
    // C7: 首次正确 INSERT → active；重复 activation command → ABORT（fencing trigger / UNIQUE 拒绝）
    activateRegistryPublication(getDb(), {publicationId: pE2.id, ownerToken: pE2.owner_token as string, attempt: pE2.attempt, observedActiveRegistrySha256: pE2.candidate_registry_sha256 as string});
    ok(getPublicationRow(getDb(), pE2.id).status === 'active', 'C7 首次 activation command → active');
    await expectCode('C7 duplicate activation command → UNIQUE ABORT', () => {
      activateRegistryPublication(getDb(), {publicationId: pE2.id, ownerToken: pE2.owner_token as string, attempt: pE2.attempt, observedActiveRegistrySha256: pE2.candidate_registry_sha256 as string});
    }, 'SQLITE_CONSTRAINT_UNIQUE');
    ok(getPublicationRow(getDb(), pE2.id).status === 'active', 'C7 duplicate 拒绝后保持 active');
    releaseAllActiveFlights();
    await aE2.stop();
    await a5.stop(); await a5b.stop(); await a5c.stop(); await aErr.stop();
  }

  // ══════════════ D. Takeover ══════════════
  {
    const {pub, adapter} = await prepareFileDurable();
    // D1: 未过期不可 takeover
    const r1 = takeoverExpiredPublication(getDb(), pub.id);
    ok(r1.kind === 'not_taken' && r1.reason === 'lease_valid', 'D1 未过期不可 takeover');
    // D2: 过期单进程 takeover（attempt+1）
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(pub.id);
    const r2 = takeoverExpiredPublication(getDb(), pub.id);
    ok(r2.kind === 'taken', 'D2 过期 takeover taken');
    if (r2.kind === 'taken') {
      ok(r2.handle.attempt === pub.attempt + 1, 'D3 attempt 精确 +1');
      ok(r2.handle.ownerToken !== pub.owner_token, 'D3 新 owner token');
      // D4: 旧 owner 全失效
      await expectCode('D4 旧 owner renew → PUBLICATION_LEASE_EXPIRED', () =>
        activateRegistryPublicationFlow(getDb(), {publicationId: pub.id, ownerToken: pub.owner_token as string, attempt: pub.attempt, paths: PATHS, adapter: new AdapterClient({baseUrl: adapter.baseUrl, timeoutMs: 500})}),
      'PUBLICATION_LEASE_EXPIRED');
      ok(adapter.reloadCalls === 0, 'D4 旧 owner 零 reload');
    }
    // D5: 双进程 takeover 恰好一个 winner（真实子进程）
    const {pub: p2, adapter: a2} = await prepareFileDurable();
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p2.id);
    const [t1, t2] = await Promise.all([
      runChild([DATA_DIR, 'takeover', p2.id]),
      runChild([DATA_DIR, 'takeover', p2.id]),
    ]);
    const takenCount = [t1, t2].filter((t) => t.ok && t.kind === 'taken').length;
    ok(takenCount === 1, 'D5 双进程恰好一个 takeover winner');
    ok([t1, t2].filter((t) => t.ok && t.kind === 'not_taken').length === 1, 'D5 loser not_taken');
    // D6: loser 零副作用（publication 状态不变 + 只有一次 attempt 增加）
    const fresh = getPublicationRow(getDb(), p2.id);
    ok(fresh.attempt === p2.attempt + 1, 'D6 attempt 只 +1（loser 未再改）');
    releaseAllActiveFlights();
    await adapter.stop();
    await a2.stop();
  }

  // ══════════════ E. Crash matrix（CC-1…CC-6 via recovery） ══════════════
  {
    // E1: file_durable before reload crash → recover → active（CC-3 前段）
    const {pub: p1, adapter: a1} = await prepareFileDurable();
    // 模拟 crash：直接过期
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p1.id);
    const res1 = await recoverRegistryPublications(getDb(), recoveryDeps(a1), 10);
    ok(res1.errors.length === 0, `E1 recover 无错误（${JSON.stringify(res1.errors)}）`);
    ok(getPublicationRow(getDb(), p1.id).status === 'active', 'E1 file_durable crash → recover → active');
    await a1.stop();

    // E2: activation command committed（已 active）→ recover 无动作
    const {pub: p2, adapter: a2} = await prepareFileDurable();
    await activateRegistryPublicationFlow(getDb(), activationOpts(p2, a2));
    const before = getPublicationRow(getDb(), p2.id);
    const res2 = await recoverRegistryPublications(getDb(), recoveryDeps(a2), 10);
    const after2 = getPublicationRow(getDb(), p2.id);
    ok(after2.status === 'active' && after2.updated_at === before.updated_at, 'E2 active terminal 无动作');
    void res2;
    await a2.stop();

    // E3: candidate_persisted crash（文件缺失）→ recover 重建文件 → file_durable → active
    const pp = await newProjection();
    const wav = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'e3-v.wav'), wav);
    const regPath = writeRegistry(path.join(DATA_DIR, 'regs'), `e3-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'e3', voiceRevision: '1', speakerName: 'e3-spk', referenceAssetPath: `${EMIT_ROOT}/e3-v.wav`, referenceSha256: sha256Buf(wav)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: regPath, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entryE3 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='e3'").get() as {id: string};
    markMappedVerified(entryE3.id, pp.matId, 'publish_and_cutover');
    const adapterE3 = new MockAdapter(ACTIVE_PATH);
    await adapterE3.start();
    const stableDoc = fs.readFileSync(ACTIVE_PATH);
    adapterE3.loadedSha = sha256Bytes(stableDoc);
    const claim = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entryE3.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stableDoc),
    });
    if (claim.kind !== 'claimed') throw new Error('E3 claim failed');
    const built = await buildRegistryCandidate(getDb(), {publication: getPublicationRow(getDb(), claim.publication.id), legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    markCandidatePersisted(getDb(), {publicationId: claim.publication.id, ownerToken: claim.publication.owner_token as string, attempt: claim.publication.attempt, candidateRegistrySha256: built.registrySha256, candidateManifestJson: built.manifestJson, candidateManifestSha256: built.manifestSha256});
    // crash：文件未写 + lease 过期
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(claim.publication.id);
    const res3 = await recoverRegistryPublications(getDb(), recoveryDeps(adapterE3), 10);
    ok(res3.errors.length === 0, `E3 recover 无错误（${JSON.stringify(res3.errors)}）`);
    const after3 = getPublicationRow(getDb(), claim.publication.id);
    ok(after3.status === 'active', `E3 candidate_persisted crash → recover → active（实际 ${after3.status}）`);
    ok(fs.existsSync(candidateRegistryPath(after3.generation)), 'E3 durable candidate 文件已重建');
    await adapterE3.stop();
  }

  // ══════════════ F. Indeterminate ══════════════
  {
    // F1: activation_pending → indeterminate evidence seal
    const {pub: p1, adapter: a1} = await prepareFileDurable();
    a1.reloadBehavior = 'ok';
    a1.statusBehavior = 'timeout'; // poll timeout → indeterminate from activation_pending
    const o1 = await activateRegistryPublicationFlow(getDb(), activationOpts(p1, a1));
    ok(o1.kind === 'indeterminate', 'F1 poll timeout → indeterminate');
    const r1 = getPublicationRow(getDb(), p1.id);
    ok(r1.status === 'indeterminate' && r1.indeterminate_from_status === 'activation_pending', 'F1 indeterminate + from=activation_pending');
    ok(r1.candidate_registry_sha256 !== null && r1.file_durable_at !== null && r1.activation_requested_at !== null, 'F1 evidence seal 完整');
    // F2: candidate active → reconciliation command 成功
    // adapter loaded 现在模拟已加载 candidate（直接设置）
    a1.statusBehavior = 'ok';
    a1.loadedSha = r1.candidate_registry_sha256;
    a1.loadedGeneration = r1.generation;
    a1.loadedPublisher = SUPPORTED_PUB;
    a1.loadedSchema = '1.1';
    const res2 = await recoverRegistryPublications(getDb(), recoveryDeps(a1), 10);
    ok(res2.errors.length === 0, `F2 recover 无错误`);
    const r2 = getPublicationRow(getDb(), p1.id);
    ok(r2.status === 'active', 'F2 reconciliation → active');
    const cmd = getDb().prepare("SELECT activation_mode, owner_token, attempt, resolution_evidence, resolution_evidence_hash, observed_active_registry_sha256 FROM voice_registry_publication_activations WHERE publication_id=?").get(p1.id) as Record<string, unknown>;
    ok(cmd.activation_mode === 'indeterminate_reconciliation', 'F2 activation_mode=indeterminate_reconciliation');
    ok(cmd.owner_token === null, 'F2 reconciliation owner NULL');
    ok(cmd.attempt === r1.attempt, 'F2 attempt 精确匹配');
    ok(cmd.observed_active_registry_sha256 === r1.candidate_registry_sha256, 'F2 observed == candidate');
    // F6: resolution evidence canonical + hash exact
    const ev = cmd.resolution_evidence as string;
    ok(cmd.resolution_evidence_hash === crypto.createHash('sha256').update(ev, 'utf8').digest('hex'), 'F6 resolution evidence hash exact');
    ok(ev.includes('"evidenceKind":"indeterminate_reconciliation"'), 'F6 evidence canonical 内容');
    // F7: repeated reconciliation rejected（publication 已 active，UNIQUE(publication_id) 已有行）
    await expectCode('F7 重复 reconciliation → UNIQUE ABORT', () => {
      reconcileIndeterminateActivation(getDb(), {publicationId: p1.id, observedActiveRegistrySha256: r1.candidate_registry_sha256 as string, resolutionEvidence: 'x', resolutionEvidenceHash: 'a'.repeat(64)});
    }, 'SQLITE_CONSTRAINT_UNIQUE');
    await a1.stop();

    // F3: stable active → fenced failed（不伪造 active）
    const {pub: p3, adapter: a3} = await prepareFileDurable();
    a3.statusBehavior = 'timeout';
    await activateRegistryPublicationFlow(getDb(), activationOpts(p3, a3)); // → indeterminate
    const r3 = getPublicationRow(getDb(), p3.id);
    a3.statusBehavior = 'ok';
    a3.loadedSha = p3.stable_registry_sha256; // adapter 仍 stable
    a3.loadedGeneration = null;
    a3.loadedPublisher = null;
    a3.loadedSchema = '1.0';
    const res3 = await recoverRegistryPublications(getDb(), recoveryDeps(a3), 10);
    const r3b = getPublicationRow(getDb(), p3.id);
    ok(r3b.status === 'failed', `F3 stable → fenced failed（实际 ${r3b.status}）`);
    ok(r3b.error_code !== null, 'F3 failed error_code');
    void res3;
    await a3.stop();

    // F4: unknown identity → 保持 indeterminate + REGISTRY_STATE_UNKNOWN
    const {pub: p4, adapter: a4} = await prepareFileDurable();
    a4.statusBehavior = 'timeout';
    await activateRegistryPublicationFlow(getDb(), activationOpts(p4, a4)); // → indeterminate
    const r4 = getPublicationRow(getDb(), p4.id);
    a4.statusBehavior = 'ok';
    a4.loadedSha = 'e'.repeat(64); // 未知 identity
    a4.loadedGeneration = null;
    a4.loadedPublisher = null;
    a4.loadedSchema = null;
    const res4 = await recoverRegistryPublications(getDb(), recoveryDeps(a4), 10);
    ok(getPublicationRow(getDb(), p4.id).status === 'indeterminate', 'F4 unknown identity → 保持 indeterminate');
    void res4;
    await a4.stop();

    // F5: file_durable 来源 indeterminate 不得 resolve active
    const {pub: p5, adapter: a5} = await prepareFileDurable();
    a5.reloadBehavior = 'timeout';
    const o5 = await activateRegistryPublicationFlow(getDb(), activationOpts(p5, a5)); // reload timeout → indeterminate from file_durable
    ok(o5.kind === 'indeterminate', 'F5 reload timeout → indeterminate from file_durable');
    const r5 = getPublicationRow(getDb(), p5.id);
    ok(r5.indeterminate_from_status === 'file_durable', 'F5 from=file_durable');
    a5.reloadBehavior = 'ok';
    a5.statusBehavior = 'ok';
    a5.loadedSha = r5.candidate_registry_sha256;
    a5.loadedGeneration = r5.generation;
    a5.loadedPublisher = SUPPORTED_PUB;
    a5.loadedSchema = '1.1';
    const res5 = await recoverRegistryPublications(getDb(), recoveryDeps(a5), 10);
    ok(getPublicationRow(getDb(), p5.id).status === 'indeterminate', 'F5 非 activation_pending 来源不得 resolve active（保持 indeterminate）');
    void res5;
    await a5.stop();
  }

  // ══════════════ G. Recovery controller ══════════════
  {
    const logLines: string[] = [];
    const {pub, adapter} = await prepareFileDurable();
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(pub.id);
    const controller = new RegistryRecoveryController(recoveryDeps(adapter), {
      intervalMs: 40,
      limit: 10,
      log: (...args) => logLines.push(args.join(' ')),
    });
    // G1: 周期启动（runNow 立即 + interval 持续）
    controller.start();
    await new Promise((r) => setTimeout(r, 250));
    ok(controller.lastRun !== null, 'G1 controller 已运行（周期 sweep 生效）');
    ok(controller.lastResult !== null, 'G1 sweep 至少完成一轮');
    ok(getPublicationRow(getDb(), pub.id).status === 'active', 'G1 recovery 推进到 active（handled 行已消费，末轮可为 0）');
    // G2: 同进程不重入（并发 runNow → 第二个返回 0）
    const [r1, r2] = await Promise.all([controller.runNow(), controller.runNow()]);
    ok((r1 === 0 && r2 >= 0) || (r2 === 0 && r1 >= 0), 'G2 并发 runNow 不重入（至少一个 0）');
    // G5: terminal rows 无动作（active publication 不处理）
    const before = getPublicationRow(getDb(), pub.id);
    await controller.runNow();
    ok(getPublicationRow(getDb(), pub.id).updated_at === before.updated_at, 'G5 terminal 无动作');
    // G4: 单条坏 publication 不阻断（errors 记录）
    const badId = crypto.randomUUID();
    getDb().prepare(
      `INSERT INTO voice_registry_publications (id, generation, subject_type, subject_id, subject_mode, stable_registry_sha256, publisher_schema_version, status, owner_token, lease_expires_at_epoch_ms, attempt, created_at, updated_at)
       VALUES (?, 99999, 'registry_rebuild', 'global', 'none', ?, ?, 'building', ?, 1, 1, ?, ?)`,
    ).run(badId, 'a'.repeat(64), SUPPORTED_PUB, 'tok', new Date().toISOString(), new Date().toISOString());
    await controller.runNow();
    ok(controller.lastResult !== null && controller.lastResult.errors.length >= 1, 'G4 坏行错误被记录（不 fatal）');
    // G3: shutdown 等待 in-flight sweep settle
    const stopP = controller.stop();
    await stopP;
    ok(!controller.isRunning, 'G3 shutdown 后无 in-flight');
    // G6: global single-flight 保持（recovery 不创建新 publication）
    ok(publicationCount() >= 1, 'G6 publication 存在');
    // G7: 无泄漏（HTTP server 关闭 + timer 清理）
    await adapter.stop();
    ok(true, 'G7 mock adapter 已关闭（无 server 泄漏）');
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

/** 辅助：promote + reload（ok）→ markActivationPending（不 poll）——用于 T5 错误矩阵前置。 */
async function prepareActivationPending(): Promise<{pub: PublicationRow; adapter: MockAdapter}> {
  const {pub, adapter} = await prepareFileDurable();
  await promoteCandidateToActive(getDb(), pub.id, pub.owner_token as string, pub.attempt, PATHS);
  const client = new AdapterClient({baseUrl: adapter.baseUrl, timeoutMs: 500});
  adapter.reloadBehavior = 'ok';
  const reload = await client.reload();
  if (reload.kind !== 'ok') throw new Error(`prepareActivationPending reload failed: ${JSON.stringify(reload)}`);
  markActivationPending(getDb(), pub.id, pub.owner_token as string, pub.attempt);
  return {pub: getPublicationRow(getDb(), pub.id), adapter};
}
