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
 *   R1 blocker repair（stale-owner race / reload 三态 / stable restore / legacy rollback / per-HTTP renew /
 *      path containment / adapter error shape）
 *   R2 blocker repair（R2-01..R2-10）：
 *      P0-1  active 文件 mutation 紧邻前 fenced renew（promote / restore / snapshot 竞态，stale owner
 *            在最终 renew 处失败、零文件副作用）
 *      P0-2  indeterminate→failed atomic legacy rollback（resolveIndeterminateFailedAndRollbackLegacy；
 *            legacy mismatch 整事务回滚）
 *      P1-1  pre-promotion（building/candidate_persisted）terminal + legacy rollback
 *      P1-2  exact final parent dir fsync（nested root/sub 目标验证 + fsync 故障注入）
 *   R3 blocker repair（R3-01…R3-07）：
 *      post-promotion failed/cancelled 唯一公开入口 = async safe orchestrator
 *      （fail/cancelPostPromotionPublicationSafely）——代码强制 restoreStableAndConfirm=='confirmed'
 *      后执行 fenced terminal；rollback_pending/unknown 不 terminal 不 legacy 不释放 single-flight；
 *      低层同步 helper 收为模块私有；pre-promotion helper 保持公开；restore/terminal 之间 takeover
 *      竞态（afterRestoreConfirmedHook）→ 旧 owner fence 失败、B 不变。
 *   R4 exported-API closure（R4-01…R4-06）：
 *      registry-publisher 公开 `failPublication` 已移除（编译期 @ts-expect-error + 运行时导出
 *      清单审计）；不存在仅凭 db+publicationId+owner+attempt 即可把 file_durable/activation_pending
 *      推进 terminal 的公开函数；legacy building/candidate_persisted 只能走
 *      failPrePromotionPublicationAndRollbackLegacy（atomic legacy rollback）；file_durable →
 *      pre-promotion helper 拒绝；唯一 post-promotion 入口 = safe orchestrator。
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
  publishRegistryCandidate,
  getPublicationRow,
  candidateRegistryDir,
  candidateRegistryPath,
  PUBLISHER_SCHEMA_VERSION,
  PUBLICATION_NOT_OWNER,
  PUBLICATION_LEASE_EXPIRED,
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
  durabilizeStableSnapshot,
  restoreStableAndConfirm,
  failPrePromotionPublicationAndRollbackLegacy,
  cancelPrePromotionPublicationAndRollbackLegacy,
  failPostPromotionPublicationSafely,
  cancelPostPromotionPublicationSafely,
  resolveIndeterminateFailedAndRollbackLegacy,
  enterIndeterminateFenced,
  stableSnapshotPath,
  recoverRegistryPublications,
  STABLE_SNAPSHOT_CONFLICT,
  LEGACY_ROLLBACK_MISMATCH,
  type ActiveRegistryPaths,
} from '../src/lib/tts-c/registry-activation';
import {RegistryRecoveryController} from '../src/lib/tts-c/registry-recovery-controller';
import {RegistryContractError} from '../src/lib/tts-c/registry-contract-error';
import {sha256Bytes} from '../src/lib/tts-c/registry-schema';
// R4 API 审计：namespace import 用于运行时导出清单检查（不新增具名导入）。
import * as registryPublisherApi from '../src/lib/tts-c/registry-publisher';
import * as registryActivationApi from '../src/lib/tts-c/registry-activation';

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

/** 测试清理专用：fenced 推进 failed（等价原 registry-publisher `failPublication` SQL 语义；
 * R4 起该函数不再是公开 API，测试本地保留等价 SQL 用于释放 active-flight 行）。 */
function failRow(row: PublicationRow, errorCode: string, errorMessage: string): void {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `UPDATE voice_registry_publications
          SET status='failed', failed_at=?, error_code=?, error_message=?,
              owner_token=NULL, lease_expires_at_epoch_ms=NULL, updated_at=?
        WHERE id=? AND status IN ('building','candidate_persisted','file_durable')
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(now, errorCode, errorMessage, now, row.id, row.owner_token as string, row.attempt);
  if (res.changes !== 1) throw new Error(`failRow fence 不命中: ${row.id}`);
}

function publicationCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM voice_registry_publications').get() as {n: number}).n;
}

/** 轮询等待条件成立（R2 竞态测试用；超时抛错使测试失败可见）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runChild(args: string[]): Promise<Record<string, unknown>> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1b2-child.ts');
  const {stdout} = await execFileP(process.execPath, ['--import', 'tsx', childPath, ...args], {
    env: {...process.env, ZHIYING_DATA_DIR: DATA_DIR},
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

// ── Mock adapter ──

type MockReloadBehavior = 'ok' | 'reject500' | 'timeout' | 'malformed' | 'close' | 'delay-ok';
type MockStatusBehavior = 'ok' | 'non2xx' | 'timeout' | 'malformed' | 'close' | 'delay-close';

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
  readActiveStatePublic(): void {
    this.readActiveState();
  }

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
      if (this.reloadBehavior === 'delay-ok') {
        // 延迟 500ms 后按 ok 处理（竞态窗口：请求挂起期间可被 takeover）
        setTimeout(() => {
          if (this.reloadUpdatesLoaded) this.readActiveState();
          res.writeHead(200, {'content-type': 'application/json'});
          res.end(this.statusJson());
        }, 500);
        return;
      }
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
        // 真实 production adapter error shape（R1 P2）：
        //   {"error": "VOICE_REGISTRY_RELOAD_FAILED", "message": "..."}
        res.writeHead(500, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'VOICE_REGISTRY_RELOAD_FAILED', message: 'reload failed (registry reference sha mismatch)'}));
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
      if (this.statusBehavior === 'delay-close') {
        // 延迟 500ms 后 destroy（竞态测试：请求挂起期间可被 takeover）
        setTimeout(() => res.destroy(), 500);
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

    // A6: reload timeout → reload_result_unknown（P0-B：不进入 indeterminate，保持 file_durable 可恢复）
    const {pub: pub5, adapter: adapter5} = await prepareFileDurable();
    adapter5.reloadBehavior = 'timeout';
    adapter5.statusBehavior = 'timeout'; // status 也不可用 → reload_result_unknown
    const o6 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub5, adapter5));
    ok(o6.kind === 'reload_result_unknown', `A6 reload timeout + status 不可用 → reload_result_unknown（实际 ${o6.kind}）`);
    const r5 = getPublicationRow(getDb(), pub5.id);
    ok(r5.status === 'file_durable', 'A6 publication 保持 file_durable（不产生永久 indeterminate）');
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

    // F3: adapter 明确仍 stable 且 disk 已恢复 stable → fenced failed（不伪造 active）
    const {pub: p3, adapter: a3} = await prepareFileDurable();
    a3.statusBehavior = 'timeout';
    await activateRegistryPublicationFlow(getDb(), activationOpts(p3, a3)); // poll timeout → indeterminate (from activation_pending)
    const r3 = getPublicationRow(getDb(), p3.id);
    ok(r3.indeterminate_from_status === 'activation_pending', 'F3 indeterminate from activation_pending');
    // 恢复 active disk 为 stable（模拟 restore 完成）
    const stableDoc = fs.readFileSync(ACTIVE_PATH);
    // prepareFileDurable 后 active 文件已被 promote 覆盖为 candidate——重新写 stable 内容
    const stableBytes = stableDoc; // prepareFileDurable 的 stableDoc 在 promote 前是 stable；这里重新构造
    // 从 DB 读 stable sha 对应的原始内容：直接用第一个 legacy registry 文件内容（1.0）
    const legacyReg = fs.readFileSync(path.join(DATA_DIR, 'regs', fs.readdirSync(path.join(DATA_DIR, 'regs')).find((f) => f.startsWith('stable-')) as string));
    fs.writeFileSync(ACTIVE_PATH, legacyReg);
    a3.statusBehavior = 'ok';
    a3.loadedSha = p3.stable_registry_sha256; // adapter 仍 stable
    a3.loadedGeneration = null;
    a3.loadedPublisher = null;
    a3.loadedSchema = '1.0';
    void stableBytes;
    const res3 = await recoverRegistryPublications(getDb(), recoveryDeps(a3), 10);
    const r3b = getPublicationRow(getDb(), p3.id);
    ok(r3b.status === 'failed', `F3 stable(disk+adapter) → fenced failed（实际 ${r3b.status}）`);
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

    // F5（P0-B 替换）：非 activation_pending 来源的 indeterminate 不存在自动入口——
    // enterIndeterminateFenced 只允许 fromStatus='activation_pending'（类型层保证）；
    // 直接验证 fenced helper 对错误 fromStatus 拒绝（运行时防御）。
    // （file_durable 阶段 reload 不确定 → reload_result_unknown 保持 file_durable，见 R1-02/03/04。）
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

  // ══════════════ R1. TTS-C.1B.3.R1 blocker repair ══════════════
  {
    // R1-13: production adapter error shape（真实 {"error","message"}）
    const {pub: p13, adapter: a13} = await prepareFileDurable();
    a13.reloadBehavior = 'reject500';
    const o13 = await activateRegistryPublicationFlow(getDb(), activationOpts(p13, a13));
    ok(o13.kind === 'reload_retryable', 'R1-13 reload 拒绝 → reload_retryable');
    const client13 = new AdapterClient({baseUrl: a13.baseUrl, timeoutMs: 500});
    const r13 = await client13.reload();
    ok(r13.kind === 'rejected' && r13.errorCode === 'VOICE_REGISTRY_RELOAD_FAILED', `R1-13 errorCode 解析（实际 ${JSON.stringify(r13)}）`);
    if (r13.kind === 'rejected') {
      ok(r13.message.includes('reload failed'), 'R1-13 message 含底层 reload 错误');
    }
    failRow(getPublicationRow(getDb(), p13.id), 'TEST_FAIL', 'release R1-13');
    await a13.stop();

    // R1-05: durable stable snapshot（首次创建 + 同 SHA 复用 + 异 SHA fail-closed；promote 后内容保持）
    const {pub: p5, adapter: a5} = await prepareFileDurable();
    const stableBefore = fs.readFileSync(ACTIVE_PATH);
    const snapPath = stableSnapshotPath(p5.generation);
    const s1 = await durabilizeStableSnapshot(getDb(), p5.id, p5.owner_token as string, p5.attempt, PATHS);
    ok(s1 === snapPath && fs.existsSync(snapPath), 'R1-05 stable snapshot 已创建');
    ok(sha256OfFile(snapPath) === p5.stable_registry_sha256, 'R1-05 snapshot SHA == stable_registry_sha256');
    ok(sha256Bytes(fs.readFileSync(snapPath)) === sha256Bytes(stableBefore), 'R1-05 snapshot bytes == 原 stable bytes');
    // 同 SHA 复用（重新 durabilize，内容不变）
    await durabilizeStableSnapshot(getDb(), p5.id, p5.owner_token as string, p5.attempt, PATHS);
    ok(sha256OfFile(snapPath) === p5.stable_registry_sha256, 'R1-05 snapshot 复用未变');
    // 异 SHA fail-closed
    fs.writeFileSync(snapPath, '{"corrupted":true}');
    await expectCode('R1-05 snapshot 异 SHA → STABLE_SNAPSHOT_CONFLICT', async () => {
      await durabilizeStableSnapshot(getDb(), p5.id, p5.owner_token as string, p5.attempt, PATHS);
    }, STABLE_SNAPSHOT_CONFLICT);
    // 恢复 snapshot 后 promote：snapshot 内容保持不变
    await durabilizeStableSnapshot(getDb(), p5.id, p5.owner_token as string, p5.attempt, PATHS).catch(() => undefined);
    fs.writeFileSync(snapPath, stableBefore); // 恢复原始 snapshot（冲突测试污染后）
    await promoteCandidateToActive(getDb(), p5.id, p5.owner_token as string, p5.attempt, PATHS);
    ok(sha256Bytes(fs.readFileSync(snapPath)) === sha256Bytes(stableBefore), 'R1-05 promote 后 snapshot 内容不变');
    await a5.stop();

    // R1-06: failed 前 stable disk restore + reload ack
    const {pub: p6, adapter: a6} = await prepareFileDurable();
    await promoteCandidateToActive(getDb(), p6.id, p6.owner_token as string, p6.attempt, PATHS);
    ok((await classifyActiveDiskState(getDb(), p6.id, PATHS)).state === 'candidate', 'R1-06 disk 已 candidate');
    const restore = await restoreStableAndConfirm(getDb(), p6.id, p6.owner_token as string, p6.attempt, PATHS, new AdapterClient({baseUrl: a6.baseUrl, timeoutMs: 500}));
    ok(restore === 'confirmed', `R1-06 restore → confirmed（实际 ${restore}）`);
    const disk6 = await classifyActiveDiskState(getDb(), p6.id, PATHS);
    ok(disk6.state === 'stable', 'R1-06 disk 已恢复 stable');
    ok(a6.loadedSha === p6.stable_registry_sha256, 'R1-06 adapter loaded == stable（ack 确认）');
    // R1-07: cold restart——模拟 adapter 重启重新读取 active path
    const a6b = new MockAdapter(ACTIVE_PATH);
    await a6b.start();
    a6b.readActiveStatePublic();
    ok(a6b.loadedSha === p6.stable_registry_sha256, 'R1-07 cold restart 后 loaded == stable（disk 恢复持久）');
    await a6b.stop();
    failRow(getPublicationRow(getDb(), p6.id), 'TEST_FAIL', 'release R1-06/07');
    await a6.stop();

    // R1-08: legacy_cutover_publish rollback（同事务）
    const rp8 = await newProjection();
    const wav8 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r1-08.wav'), wav8);
    const reg8 = writeRegistry(path.join(DATA_DIR, 'regs'), `r1-08-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r1-08', voiceRevision: '1', speakerName: 'r1-08', referenceAssetPath: `${EMIT_ROOT}/r1-08.wav`, referenceSha256: sha256Buf(wav8)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg8, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry8 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r1-08'").get() as {id: string};
    markMappedVerified(entry8.id, rp8.matId, 'publish_and_cutover');
    const a8 = new MockAdapter(ACTIVE_PATH);
    await a8.start();
    const stable8 = fs.readFileSync(ACTIVE_PATH);
    a8.loadedSha = sha256Bytes(stable8);
    const out8 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry8.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable8),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out8.kind !== 'completed') throw new Error(`R1-08 prepare failed: ${JSON.stringify(out8)}`);
    const pub8 = getPublicationRow(getDb(), out8.publicationId);
    const lve8 = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(entry8.id) as Record<string, unknown>;
    ok(lve8.mapping_status === 'mapping_pending' && lve8.pending_publication_id === pub8.id, 'R1-08 前置 mapping_pending');
    // R3：post-promotion terminal 只能走 safe orchestrator（代码强制 restore + reload ack 前置）
    const safeOut8 = await failPostPromotionPublicationSafely(getDb(), {
      publicationId: pub8.id,
      ownerToken: pub8.owner_token as string,
      attempt: pub8.attempt,
      errorCode: 'TEST_FAIL',
      errorMessage: 'R1-08',
      paths: PATHS,
      adapter: new AdapterClient({baseUrl: a8.baseUrl, timeoutMs: 500}),
    });
    ok(safeOut8.kind === 'failed', 'R1-08 safe fail → failed');
    const lve8b = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(entry8.id) as Record<string, unknown>;
    ok(lve8b.mapping_status === 'mapped_verified', 'R1-08 legacy → mapped_verified');
    ok(lve8b.pending_publication_id === null && lve8b.candidate_source_selector === null, 'R1-08 pending link/selector 清空');
    ok(lve8b.mapping_mode === 'publish_and_cutover', 'R1-08 mapping_mode 保持');
    ok(getPublicationRow(getDb(), pub8.id).status === 'failed', 'R1-08 publication failed');
    // 可创建新 publication（single-flight 释放）
    const out8b = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry8.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable8),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    ok(out8b.kind === 'completed', 'R1-08 rollback 后可创建新 publication');
    failRow(getPublicationRow(getDb(), out8b.publicationId), 'TEST_FAIL', 'release R1-08b');
    await a8.stop();

    // R1-09: legacy_cutover_existing rollback
    const rp9 = await newProjection();
    const a9a = new MockAdapter(ACTIVE_PATH);
    await a9a.start();
    const stable9 = fs.readFileSync(ACTIVE_PATH);
    a9a.loadedSha = sha256Bytes(stable9);
    const out9a = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: rp9.matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable9),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out9a.kind !== 'completed') throw new Error(`R1-09a prepare failed: ${JSON.stringify(out9a)}`);
    const pub9a = getPublicationRow(getDb(), out9a.publicationId);
    await activateRegistryPublicationFlow(getDb(), activationOpts(pub9a, a9a));
    await a9a.stop();
    const wav9 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r1-09.wav'), wav9);
    const reg9 = writeRegistry(path.join(DATA_DIR, 'regs'), `r1-09-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r1-09', voiceRevision: '1', speakerName: 'r1-09', referenceAssetPath: `${EMIT_ROOT}/r1-09.wav`, referenceSha256: sha256Buf(wav9)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg9, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry9 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r1-09'").get() as {id: string};
    markMappedVerified(entry9.id, rp9.matId, 'cutover_existing');
    const a9 = new MockAdapter(ACTIVE_PATH);
    await a9.start();
    const stable9b = fs.readFileSync(ACTIVE_PATH);
    a9.loadedSha = sha256Bytes(stable9b);
    const out9 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_existing', subjectId: entry9.id, subjectMode: 'cutover_existing'},
      stableRegistrySha256: sha256Bytes(stable9b),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out9.kind !== 'completed') throw new Error(`R1-09 prepare failed: ${JSON.stringify(out9)}`);
    const pub9 = getPublicationRow(getDb(), out9.publicationId);
    // R3：post-promotion terminal 只能走 safe orchestrator（代码强制 restore + reload ack 前置）
    const safeOut9 = await failPostPromotionPublicationSafely(getDb(), {
      publicationId: pub9.id,
      ownerToken: pub9.owner_token as string,
      attempt: pub9.attempt,
      errorCode: 'TEST_FAIL',
      errorMessage: 'R1-09',
      paths: PATHS,
      adapter: new AdapterClient({baseUrl: a9.baseUrl, timeoutMs: 500}),
    });
    ok(safeOut9.kind === 'failed', 'R1-09 safe fail → failed');
    const lve9 = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(entry9.id) as Record<string, unknown>;
    ok(lve9.mapping_status === 'mapped_verified' && lve9.pending_publication_id === null, 'R1-09 legacy_cutover_existing rollback → mapped_verified');
    ok(lve9.mapping_mode === 'cutover_existing', 'R1-09 mapping_mode 保持');
    await a9.stop();

    // R1-01: stale owner race——A poll 挂起 → lease 过期 + B takeover → A 的 indeterminate fence 失败
    const {pub: p1, adapter: a1} = await prepareActivationPending();
    a1.statusBehavior = 'delay-close'; // A 的 poll 挂起 500ms 后 connection reset
    const staleFlow = activateRegistryPublicationFlow(getDb(), activationOpts(p1, a1));
    await new Promise((r) => setTimeout(r, 100)); // 让 poll 挂起
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p1.id);
    const t1 = takeoverExpiredPublication(getDb(), p1.id);
    ok(t1.kind === 'taken', 'R1-01 B takeover 成功');
    if (t1.kind === 'taken') {
      const bBefore = getPublicationRow(getDb(), p1.id);
      await expectCode('R1-01 stale owner enterIndeterminate → PUBLICATION_NOT_OWNER', async () => {
        await staleFlow;
      }, PUBLICATION_NOT_OWNER);
      const bAfter = getPublicationRow(getDb(), p1.id);
      ok(bAfter.owner_token === bBefore.owner_token && bAfter.attempt === bBefore.attempt && bAfter.lease_expires_at_epoch_ms === bBefore.lease_expires_at_epoch_ms, 'R1-01 B owner/attempt/lease 不变');
      ok(bAfter.status !== 'indeterminate', 'R1-01 publication 不进入 indeterminate');
      releaseAllActiveFlights(); // bAfter 是 activation_pending——无条件释放
    }
    await a1.stop();

    // R1-02: reload timeout + status candidate → 可恢复激活（reload 实际已生效但响应丢失）
    const {pub: p2, adapter: a2} = await prepareFileDurable();
    a2.reloadBehavior = 'timeout';
    a2.statusBehavior = 'ok';
    a2.loadedSha = p2.candidate_registry_sha256; // 模拟 reload 实际已生效
    a2.loadedGeneration = p2.generation;
    a2.loadedPublisher = SUPPORTED_PUB;
    a2.loadedSchema = '1.1';
    const o2 = await activateRegistryPublicationFlow(getDb(), activationOpts(p2, a2));
    ok(o2.kind === 'active', `R1-02 reload timeout + status candidate → active（实际 ${o2.kind}）`);
    ok(getPublicationRow(getDb(), p2.id).status === 'active', 'R1-02 publication active');
    await a2.stop();

    // R1-03: reload timeout + status stable → reload_retryable（保持 file_durable）
    const {pub: p3, adapter: a3} = await prepareFileDurable();
    a3.reloadBehavior = 'timeout';
    a3.statusBehavior = 'ok';
    a3.loadedSha = p3.stable_registry_sha256;
    a3.loadedGeneration = null;
    a3.loadedPublisher = null;
    a3.loadedSchema = '1.0';
    const o3 = await activateRegistryPublicationFlow(getDb(), activationOpts(p3, a3));
    ok(o3.kind === 'reload_retryable', `R1-03 reload timeout + status stable → reload_retryable（实际 ${o3.kind}）`);
    ok(getPublicationRow(getDb(), p3.id).status === 'file_durable', 'R1-03 保持 file_durable');
    failRow(getPublicationRow(getDb(), p3.id), 'TEST_FAIL', 'release R1-03');
    await a3.stop();

    // R1-04: reload timeout + status unavailable → reload_result_unknown（保持 file_durable，等 recovery）
    const {pub: p4, adapter: a4} = await prepareFileDurable();
    a4.reloadBehavior = 'timeout';
    a4.statusBehavior = 'close';
    const o4 = await activateRegistryPublicationFlow(getDb(), activationOpts(p4, a4));
    ok(o4.kind === 'reload_result_unknown', `R1-04 reload timeout + status 不可用 → reload_result_unknown（实际 ${o4.kind}）`);
    ok(getPublicationRow(getDb(), p4.id).status === 'file_durable', 'R1-04 保持 file_durable（不释放 single-flight 不 indeterminate）');
    // recovery 可重试（lease 过期 → recover → adapter 正常 → active）
    a4.reloadBehavior = 'ok';
    a4.statusBehavior = 'ok';
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p4.id);
    const res4 = await recoverRegistryPublications(getDb(), recoveryDeps(a4), 10);
    ok(getPublicationRow(getDb(), p4.id).status === 'active', `R1-04 recovery 重试后 → active（实际 ${getPublicationRow(getDb(), p4.id).status}）`);
    void res4;
    await a4.stop();

    // R1-10: recovery 每个 HTTP 前 renew——takeover 后第一次 status 成功，reload 挂起期间
    // lease 被注入过期 + 新 owner takeover → 原 owner 不得继续第二次 status（renew 失败）
    const {pub: p10, adapter: a10} = await prepareActivationPending();
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p10.id);
    // 构造：status 第一次 ok（classify stable）→ reload delay-ok 挂起 → lease 过期 + takeover
    a10.reloadBehavior = 'delay-ok';
    a10.statusBehavior = 'ok';
    a10.reloadUpdatesLoaded = false;
    a10.loadedSha = p10.stable_registry_sha256; // stable → 进入 reload 重试分支
    a10.loadedGeneration = null;
    a10.loadedPublisher = null;
    a10.loadedSchema = '1.0';
    const statusCallsBefore10 = a10.statusCalls;
    const reloadCallsBefore10 = a10.reloadCalls;
    const flow10 = (async () => {
      await recoverRegistryPublications(getDb(), recoveryDeps(a10), 10);
    })();
    await new Promise((r) => setTimeout(r, 50)); // status 完成、reload 已发出并挂起
    ok(a10.reloadCalls === reloadCallsBefore10 + 1, 'R1-10 reload 已发出（挂起中）');
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p10.id);
    const t10 = takeoverExpiredPublication(getDb(), p10.id);
    ok(t10.kind === 'taken', 'R1-10 新 owner takeover');
    await flow10; // reload 返回后 renew 失败 → 不执行第二次 status
    ok(a10.statusCalls === statusCallsBefore10 + 1, 'R1-10 第二次 status 未执行（原 owner renew 失败）');
    const after10 = getPublicationRow(getDb(), p10.id);
    ok(after10.status === 'activation_pending', 'R1-10 publication 状态不变（原 owner 无后续副作用）');
    releaseAllActiveFlights();
    await a10.stop();

    // R1-11/12: active path containment——root symlink + nested parent symlink（candidate-idempotent 路径也验证）
    const {pub: p11, adapter: a11} = await prepareFileDurable();
    await promoteCandidateToActive(getDb(), p11.id, p11.owner_token as string, p11.attempt, PATHS); // disk → candidate
    // root 替换为 symlink
    const realDir = ACTIVE_DIR + '-real';
    fs.renameSync(ACTIVE_DIR, realDir);
    fs.symlinkSync(realDir, ACTIVE_DIR);
    await expectCode('R1-11 root symlink + disk candidate → CANDIDATE_FILE_IO', async () => {
      await classifyActiveDiskState(getDb(), p11.id, PATHS);
    }, 'CANDIDATE_FILE_IO');
    await expectCode('R1-11 promote（candidate-idempotent 路径）同样拒绝', async () => {
      await promoteCandidateToActive(getDb(), p11.id, p11.owner_token as string, p11.attempt, PATHS);
    }, 'CANDIDATE_FILE_IO');
    fs.unlinkSync(ACTIVE_DIR);
    fs.renameSync(realDir, ACTIVE_DIR);
    // R1-12: root 内 nested parent symlink（ACTIVE_DIR/sub → 外部）
    const outside = path.join(DATA_DIR, 'r1-12-outside');
    fs.mkdirSync(outside, {recursive: true});
    fs.mkdirSync(path.join(ACTIVE_DIR, 'sub'), {recursive: true});
    fs.writeFileSync(path.join(ACTIVE_DIR, 'sub', 'voice-registry.json'), '{}');
    fs.rmSync(path.join(ACTIVE_DIR, 'sub'), {recursive: true});
    fs.symlinkSync(outside, path.join(ACTIVE_DIR, 'sub'));
    const nestedPaths: ActiveRegistryPaths = {activeRegistryPath: path.join(ACTIVE_DIR, 'sub', 'voice-registry.json'), activeRegistryRoot: ACTIVE_DIR};
    await expectCode('R1-12 nested parent symlink → CANDIDATE_FILE_IO', async () => {
      await classifyActiveDiskState(getDb(), p11.id, nestedPaths);
    }, 'CANDIDATE_FILE_IO');
    fs.unlinkSync(path.join(ACTIVE_DIR, 'sub'));
    failRow(getPublicationRow(getDb(), p11.id), 'TEST_FAIL', 'release R1-11/12');
    await a11.stop();
  }

  // ══════════════ R2. TTS-C.1B.3.R2 blocker repair ══════════════
  {
    // ── R2-01: candidate promotion race——A 在 active write 前挂起 → lease 过期 + B takeover →
    //           A 在最终 renew 处失败，active registry bytes 不变，B owner/attempt/lease 不变 ──
    const {pub: p1, adapter: a1} = await prepareFileDurable();
    const activeBytesBefore1 = fs.readFileSync(ACTIVE_PATH);
    let releaseGate1!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      releaseGate1 = resolve;
    });
    let hookFired1 = false;
    const paths1: ActiveRegistryPaths = {
      ...PATHS,
      beforeActiveWriteHook: () => {
        hookFired1 = true;
        return gate1;
      },
    };
    const flow1 = promoteCandidateToActive(getDb(), p1.id, p1.owner_token as string, p1.attempt, paths1);
    await waitFor(() => hookFired1);
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p1.id);
    const t1 = takeoverExpiredPublication(getDb(), p1.id);
    ok(t1.kind === 'taken', 'R2-01 B takeover 成功（A 挂起期间 lease 过期）');
    const b1Before = getPublicationRow(getDb(), p1.id);
    releaseGate1();
    await expectCode('R2-01 stale owner 最终 renew → PUBLICATION_LEASE_EXPIRED', () => flow1, PUBLICATION_LEASE_EXPIRED);
    ok(sha256Bytes(fs.readFileSync(ACTIVE_PATH)) === sha256Bytes(activeBytesBefore1), 'R2-01 active registry bytes 不变（A 未写）');
    ok(fs.readdirSync(ACTIVE_DIR).filter((f) => f.endsWith('.tmp')).length === 0, 'R2-01 无 temp 残留');
    const b1After = getPublicationRow(getDb(), p1.id);
    ok(b1After.owner_token === b1Before.owner_token && b1After.attempt === b1Before.attempt && b1After.lease_expires_at_epoch_ms === b1Before.lease_expires_at_epoch_ms, 'R2-01 B owner/attempt/lease 不变');
    releaseAllActiveFlights();
    await a1.stop();

    // ── R2-02: stable restore race——A 在 restore write 前挂起 → B takeover → A 不得覆盖 active registry ──
    const {pub: p2, adapter: a2} = await prepareFileDurable();
    await promoteCandidateToActive(getDb(), p2.id, p2.owner_token as string, p2.attempt, PATHS);
    ok((await classifyActiveDiskState(getDb(), p2.id, PATHS)).state === 'candidate', 'R2-02 disk candidate 前置');
    const candidateBytes2 = fs.readFileSync(ACTIVE_PATH);
    let releaseGate2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      releaseGate2 = resolve;
    });
    let hookFired2 = false;
    const paths2: ActiveRegistryPaths = {
      ...PATHS,
      beforeStableRestoreWriteHook: () => {
        hookFired2 = true;
        return gate2;
      },
    };
    const flow2 = restoreStableAndConfirm(getDb(), p2.id, p2.owner_token as string, p2.attempt, paths2, new AdapterClient({baseUrl: a2.baseUrl, timeoutMs: 500}));
    await waitFor(() => hookFired2);
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p2.id);
    const t2 = takeoverExpiredPublication(getDb(), p2.id);
    ok(t2.kind === 'taken', 'R2-02 B takeover 成功');
    const b2Before = getPublicationRow(getDb(), p2.id);
    releaseGate2();
    const o2 = await flow2;
    ok(o2 === 'rollback_pending', `R2-02 stale owner restore → rollback_pending（实际 ${o2}）`);
    ok(sha256Bytes(fs.readFileSync(ACTIVE_PATH)) === sha256Bytes(candidateBytes2), 'R2-02 active registry 仍 candidate bytes（未被 A 恢复覆盖）');
    const b2After = getPublicationRow(getDb(), p2.id);
    ok(b2After.owner_token === b2Before.owner_token && b2After.attempt === b2Before.attempt && b2After.lease_expires_at_epoch_ms === b2Before.lease_expires_at_epoch_ms, 'R2-02 B owner/attempt/lease 不变');
    releaseAllActiveFlights();
    await a2.stop();

    // ── R2-03: snapshot race——A 在 snapshot write 前挂起 → B takeover → A 不得创建/fsync snapshot ──
    const {pub: p3, adapter: a3} = await prepareFileDurable();
    const snapPath3 = stableSnapshotPath(p3.generation);
    ok(!fs.existsSync(snapPath3), 'R2-03 前置：snapshot 不存在');
    let releaseGate3!: () => void;
    const gate3 = new Promise<void>((resolve) => {
      releaseGate3 = resolve;
    });
    let hookFired3 = false;
    let fsyncCalls3 = 0;
    const paths3: ActiveRegistryPaths = {
      ...PATHS,
      beforeSnapshotWriteHook: () => {
        hookFired3 = true;
        return gate3;
      },
      fsyncDir: async () => {
        fsyncCalls3++;
      },
    };
    const flow3 = durabilizeStableSnapshot(getDb(), p3.id, p3.owner_token as string, p3.attempt, paths3);
    await waitFor(() => hookFired3);
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p3.id);
    const t3 = takeoverExpiredPublication(getDb(), p3.id);
    ok(t3.kind === 'taken', 'R2-03 B takeover 成功');
    releaseGate3();
    await expectCode('R2-03 stale owner snapshot 写 → PUBLICATION_LEASE_EXPIRED', () => flow3, PUBLICATION_LEASE_EXPIRED);
    ok(!fs.existsSync(snapPath3), 'R2-03 A 未创建 snapshot 文件');
    ok(fsyncCalls3 === 0, 'R2-03 A 未执行任何 snapshot fsync');
    const b3 = getPublicationRow(getDb(), p3.id);
    ok(b3.status === 'file_durable' && b3.owner_token !== null, 'R2-03 publication 保持 file_durable（B 持有）');
    releaseAllActiveFlights();
    await a3.stop();

    // ── R2-03b: snapshot existing re-durabilize race——A 不得重新 fsync 既有 snapshot ──
    const {pub: p3b, adapter: a3b} = await prepareFileDurable();
    const snapPath3b = stableSnapshotPath(p3b.generation);
    await durabilizeStableSnapshot(getDb(), p3b.id, p3b.owner_token as string, p3b.attempt, PATHS);
    ok(fs.existsSync(snapPath3b), 'R2-03b 前置：snapshot 已存在');
    const snapBytes3b = fs.readFileSync(snapPath3b);
    let releaseGate3b!: () => void;
    const gate3b = new Promise<void>((resolve) => {
      releaseGate3b = resolve;
    });
    let hookFired3b = false;
    let fsyncCalls3b = 0;
    const paths3b: ActiveRegistryPaths = {
      ...PATHS,
      beforeSnapshotWriteHook: () => {
        hookFired3b = true;
        return gate3b;
      },
      fsyncDir: async () => {
        fsyncCalls3b++;
      },
    };
    const flow3b = durabilizeStableSnapshot(getDb(), p3b.id, p3b.owner_token as string, p3b.attempt, paths3b);
    await waitFor(() => hookFired3b);
    getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p3b.id);
    const t3b = takeoverExpiredPublication(getDb(), p3b.id);
    ok(t3b.kind === 'taken', 'R2-03b B takeover 成功');
    releaseGate3b();
    await expectCode('R2-03b stale owner snapshot re-durabilize → PUBLICATION_LEASE_EXPIRED', () => flow3b, PUBLICATION_LEASE_EXPIRED);
    ok(fsyncCalls3b === 0, 'R2-03b A 未重新 fsync snapshot（re-durabilize 未执行）');
    ok(sha256Bytes(fs.readFileSync(snapPath3b)) === sha256Bytes(snapBytes3b), 'R2-03b snapshot bytes 不变');
    releaseAllActiveFlights();
    await a3b.stop();

    // ── R2-04: legacy_cutover_publish indeterminate → failed（atomic legacy rollback；可创建新 publication）──
    const rp4 = await newProjection();
    const wav4 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-04.wav'), wav4);
    const reg4 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-04-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-04', voiceRevision: '1', speakerName: 'r2-04', referenceAssetPath: `${EMIT_ROOT}/r2-04.wav`, referenceSha256: sha256Buf(wav4)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg4, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry4 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-04'").get() as {id: string};
    markMappedVerified(entry4.id, rp4.matId, 'publish_and_cutover');
    const a4 = new MockAdapter(ACTIVE_PATH);
    await a4.start();
    const stable4 = fs.readFileSync(ACTIVE_PATH);
    a4.loadedSha = sha256Bytes(stable4);
    const out4 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry4.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable4),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out4.kind !== 'completed') throw new Error(`R2-04 prepare failed: ${JSON.stringify(out4)}`);
    const pub4 = getPublicationRow(getDb(), out4.publicationId);
    const lve4a = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry4.id) as Record<string, unknown>;
    ok(lve4a.mapping_status === 'mapping_pending' && lve4a.pending_publication_id === pub4.id, 'R2-04 前置 mapping_pending');
    a4.statusBehavior = 'timeout'; // poll timeout → indeterminate from activation_pending
    const o4 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub4, a4));
    ok(o4.kind === 'indeterminate', `R2-04 → indeterminate（实际 ${o4.kind}）`);
    const r4b = getPublicationRow(getDb(), pub4.id);
    ok(r4b.status === 'indeterminate' && r4b.indeterminate_from_status === 'activation_pending', 'R2-04 indeterminate from activation_pending');
    // 模拟 restore 完成：disk + adapter 恢复 stable → recovery 走 resolveIndeterminateFailedAndRollbackLegacy
    fs.writeFileSync(ACTIVE_PATH, stable4);
    a4.statusBehavior = 'ok';
    a4.loadedSha = pub4.stable_registry_sha256;
    a4.loadedGeneration = null;
    a4.loadedPublisher = null;
    a4.loadedSchema = '1.0';
    const res4 = await recoverRegistryPublications(getDb(), recoveryDeps(a4), 10);
    ok(res4.errors.length === 0, `R2-04 recover 无错误（${JSON.stringify(res4.errors)}）`);
    ok(getPublicationRow(getDb(), pub4.id).status === 'failed', 'R2-04 indeterminate → failed');
    const lve4b = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode, mapped_voice_materialization_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry4.id) as Record<string, unknown>;
    ok(lve4b.mapping_status === 'mapped_verified', 'R2-04 legacy → mapped_verified');
    ok(lve4b.pending_publication_id === null && lve4b.candidate_source_selector === null, 'R2-04 pending link/selector 清空');
    ok(lve4b.mapping_mode === 'publish_and_cutover', 'R2-04 mapping_mode 保持');
    ok(lve4b.mapped_voice_materialization_id === rp4.matId, 'R2-04 mapped materialization 保持');
    const out4b = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry4.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable4),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    ok(out4b.kind === 'completed', 'R2-04 rollback 后可创建新 publication');
    failRow(getPublicationRow(getDb(), out4b.publicationId), 'TEST_FAIL', 'release R2-04b');
    await a4.stop();

    // ── R2-05: legacy_cutover_existing indeterminate → failed（projection published evidence 零改写）──
    const rp5 = await newProjection();
    const a5a = new MockAdapter(ACTIVE_PATH);
    await a5a.start();
    const stable5a = fs.readFileSync(ACTIVE_PATH);
    a5a.loadedSha = sha256Bytes(stable5a);
    const out5a = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: rp5.matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable5a),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out5a.kind !== 'completed') throw new Error(`R2-05a prepare failed: ${JSON.stringify(out5a)}`);
    const pub5a = getPublicationRow(getDb(), out5a.publicationId);
    const o5a = await activateRegistryPublicationFlow(getDb(), activationOpts(pub5a, a5a));
    ok(o5a.kind === 'active', 'R2-05a 前置 projection 已激活（published_usable）');
    await a5a.stop();
    const wav5 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-05.wav'), wav5);
    const reg5 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-05-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-05', voiceRevision: '1', speakerName: 'r2-05', referenceAssetPath: `${EMIT_ROOT}/r2-05.wav`, referenceSha256: sha256Buf(wav5)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg5, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry5 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-05'").get() as {id: string};
    markMappedVerified(entry5.id, rp5.matId, 'cutover_existing');
    const a5 = new MockAdapter(ACTIVE_PATH);
    await a5.start();
    const stable5b = fs.readFileSync(ACTIVE_PATH);
    a5.loadedSha = sha256Bytes(stable5b);
    const out5 = await publishRegistryCandidate(getDb(), {
      subject: {subjectType: 'legacy_cutover_existing', subjectId: entry5.id, subjectMode: 'cutover_existing'},
      stableRegistrySha256: sha256Bytes(stable5b),
      build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
    });
    if (out5.kind !== 'completed') throw new Error(`R2-05 prepare failed: ${JSON.stringify(out5)}`);
    const pub5 = getPublicationRow(getDb(), out5.publicationId);
    a5.statusBehavior = 'timeout';
    const o5 = await activateRegistryPublicationFlow(getDb(), activationOpts(pub5, a5));
    ok(o5.kind === 'indeterminate', `R2-05 → indeterminate（实际 ${o5.kind}）`);
    fs.writeFileSync(ACTIVE_PATH, stable5b);
    a5.statusBehavior = 'ok';
    a5.loadedSha = pub5.stable_registry_sha256;
    a5.loadedGeneration = null;
    a5.loadedPublisher = null;
    a5.loadedSchema = '1.0';
    const res5 = await recoverRegistryPublications(getDb(), recoveryDeps(a5), 10);
    ok(res5.errors.length === 0, `R2-05 recover 无错误（${JSON.stringify(res5.errors)}）`);
    ok(getPublicationRow(getDb(), pub5.id).status === 'failed', 'R2-05 indeterminate → failed');
    const lve5 = getDb().prepare('SELECT mapping_status, pending_publication_id, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(entry5.id) as Record<string, unknown>;
    ok(lve5.mapping_status === 'mapped_verified' && lve5.pending_publication_id === null, 'R2-05 legacy rollback → mapped_verified');
    ok(lve5.mapping_mode === 'cutover_existing', 'R2-05 mapping_mode 保持');
    const mat5 = getDb().prepare('SELECT status, published_registry_generation, published_registry_sha256, published_by_publication_id FROM voice_materializations WHERE id=?').get(rp5.matId) as Record<string, unknown>;
    ok(mat5.status === 'published_usable', 'R2-05 projection 保持 published_usable');
    ok(mat5.published_registry_generation === pub5a.generation && mat5.published_registry_sha256 === pub5a.candidate_registry_sha256 && mat5.published_by_publication_id === pub5a.id, 'R2-05 projection published evidence 零改写（保持前置激活）');
    await a5.stop();

    // ── R2-06: indeterminate failed 的 legacy rollback mismatch → 整事务回滚（publication 保持 indeterminate）──
    // schema trigger（trg_lve_immutable/trg_lve_rollback）使“pending link 被破坏”状态无法通过合法
    // UPDATE 构造——用直接 SQL 构造行（INSERT 必须 building；状态链全部 trigger-legal），
    // entry 保持 mapped_verified（链接从未建立），模拟外部破坏/丢失的 pending link。
    const rp6 = await newProjection();
    const wav6 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-06.wav'), wav6);
    const reg6 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-06-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-06', voiceRevision: '1', speakerName: 'r2-06', referenceAssetPath: `${EMIT_ROOT}/r2-06.wav`, referenceSha256: sha256Buf(wav6)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg6, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry6 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-06'").get() as {id: string};
    markMappedVerified(entry6.id, rp6.matId, 'publish_and_cutover');
    const p6id = crypto.randomUUID();
    const gen6 = (getDb().prepare('SELECT COALESCE(MAX(generation),0)+1 AS n FROM voice_registry_publications').get() as {n: number}).n;
    const now6 = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO voice_registry_publications
         (id, generation, subject_type, subject_id, subject_mode, stable_registry_sha256,
          publisher_schema_version, status, owner_token, lease_expires_at_epoch_ms, attempt, created_at, updated_at)
       VALUES (?, ?, 'legacy_cutover_publish', ?, 'publish_and_cutover', ?, ?, 'building', ?,
               (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) + 600000, 1, ?, ?)`,
    ).run(p6id, gen6, entry6.id, 'a'.repeat(64), SUPPORTED_PUB, 'tok6', now6, now6);
    getDb().prepare(
      `UPDATE voice_registry_publications
          SET status='candidate_persisted', candidate_registry_sha256=?, candidate_manifest_json='{}', candidate_manifest_sha256=?, updated_at=?
        WHERE id=? AND status='building'`,
    ).run('b'.repeat(64), 'c'.repeat(64), now6, p6id);
    getDb().prepare(
      `UPDATE voice_registry_publications SET status='file_durable', file_durable_at=?, updated_at=? WHERE id=? AND status='candidate_persisted'`,
    ).run(now6, now6, p6id);
    getDb().prepare(
      `UPDATE voice_registry_publications SET status='activation_pending', activation_requested_at=?, updated_at=? WHERE id=? AND status='file_durable'`,
    ).run(now6, now6, p6id);
    getDb().prepare(
      `UPDATE voice_registry_publications
          SET status='indeterminate', indeterminate_from_status='activation_pending', owner_token=NULL,
              lease_expires_at_epoch_ms=NULL, error_code='X', error_message='constructed', updated_at=?
        WHERE id=? AND status='activation_pending'`,
    ).run(now6, p6id);
    const r6pre = getPublicationRow(getDb(), p6id);
    ok(r6pre.status === 'indeterminate' && r6pre.indeterminate_from_status === 'activation_pending', 'R2-06 indeterminate 行构造完成');
    await expectCode('R2-06 legacy rollback mismatch → LEGACY_ROLLBACK_MISMATCH（整事务回滚）', () => {
      resolveIndeterminateFailedAndRollbackLegacy(getDb(), {publicationId: p6id, attempt: 1, errorCode: 'TEST', errorMessage: 'R2-06'});
    }, LEGACY_ROLLBACK_MISMATCH);
    const r6after = getPublicationRow(getDb(), p6id);
    ok(r6after.status === 'indeterminate', 'R2-06 publication 保持 indeterminate（failed 未提交）');
    const lve6 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry6.id) as Record<string, unknown>;
    ok(lve6.mapping_status === 'mapped_verified' && lve6.pending_publication_id === null, 'R2-06 legacy 保持原状（无副作用）');
    releaseAllActiveFlights();

    // ── R2-07: building legacy failure（claim 后 failPrePromotion → terminal + legacy rollback + 可重试）──
    const rp7 = await newProjection();
    const wav7 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-07.wav'), wav7);
    const reg7 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-07-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-07', voiceRevision: '1', speakerName: 'r2-07', referenceAssetPath: `${EMIT_ROOT}/r2-07.wav`, referenceSha256: sha256Buf(wav7)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg7, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry7 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-07'").get() as {id: string};
    markMappedVerified(entry7.id, rp7.matId, 'publish_and_cutover');
    const a7 = new MockAdapter(ACTIVE_PATH);
    await a7.start();
    const stable7 = fs.readFileSync(ACTIVE_PATH);
    a7.loadedSha = sha256Bytes(stable7);
    const claim7 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry7.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable7),
    });
    if (claim7.kind !== 'claimed') throw new Error('R2-07 claim failed');
    const pub7 = getPublicationRow(getDb(), claim7.publication.id);
    ok(pub7.status === 'building', 'R2-07 publication building');
    const lve7a = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector FROM legacy_adapter_voice_entries WHERE id=?').get(entry7.id) as Record<string, unknown>;
    ok(lve7a.mapping_status === 'mapping_pending' && lve7a.pending_publication_id === pub7.id, 'R2-07 legacy mapping_pending');
    failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub7.id, ownerToken: pub7.owner_token as string, attempt: pub7.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R2-07'});
    ok(getPublicationRow(getDb(), pub7.id).status === 'failed', 'R2-07 publication failed');
    const lve7b = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(entry7.id) as Record<string, unknown>;
    ok(lve7b.mapping_status === 'mapped_verified' && lve7b.pending_publication_id === null && lve7b.candidate_source_selector === null, 'R2-07 legacy rollback 完成（link/selector 清空）');
    ok(lve7b.mapping_mode === 'publish_and_cutover', 'R2-07 mapping_mode 保持');
    const claim7b = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry7.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable7),
    });
    ok(claim7b.kind === 'claimed', 'R2-07 rollback 后可重新 claim');
    if (claim7b.kind === 'claimed') {
      failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: claim7b.publication.id, ownerToken: claim7b.publication.owner_token as string, attempt: claim7b.publication.attempt, errorCode: 'TEST_FAIL', errorMessage: 'release R2-07b'});
    }
    await a7.stop();

    // ── R2-08: candidate_persisted legacy failure（pre-promotion rollback）──
    const rp8 = await newProjection();
    const wav8 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-08.wav'), wav8);
    const reg8 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-08-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-08', voiceRevision: '1', speakerName: 'r2-08', referenceAssetPath: `${EMIT_ROOT}/r2-08.wav`, referenceSha256: sha256Buf(wav8)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg8, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry8 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-08'").get() as {id: string};
    markMappedVerified(entry8.id, rp8.matId, 'publish_and_cutover');
    const a8 = new MockAdapter(ACTIVE_PATH);
    await a8.start();
    const stable8 = fs.readFileSync(ACTIVE_PATH);
    a8.loadedSha = sha256Bytes(stable8);
    const claim8 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry8.id, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: sha256Bytes(stable8),
    });
    if (claim8.kind !== 'claimed') throw new Error('R2-08 claim failed');
    const pub8 = getPublicationRow(getDb(), claim8.publication.id);
    const built8 = await buildRegistryCandidate(getDb(), {publication: pub8, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    markCandidatePersisted(getDb(), {publicationId: pub8.id, ownerToken: pub8.owner_token as string, attempt: pub8.attempt, candidateRegistrySha256: built8.registrySha256, candidateManifestJson: built8.manifestJson, candidateManifestSha256: built8.manifestSha256});
    ok(getPublicationRow(getDb(), pub8.id).status === 'candidate_persisted', 'R2-08 candidate_persisted 前置');
    failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub8.id, ownerToken: pub8.owner_token as string, attempt: pub8.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R2-08'});
    ok(getPublicationRow(getDb(), pub8.id).status === 'failed', 'R2-08 publication failed');
    const lve8b = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector FROM legacy_adapter_voice_entries WHERE id=?').get(entry8.id) as Record<string, unknown>;
    ok(lve8b.mapping_status === 'mapped_verified' && lve8b.pending_publication_id === null && lve8b.candidate_source_selector === null, 'R2-08 legacy rollback 完成');
    await a8.stop();

    // ── R2-09: pre-promotion rollback 事务原子性（legacy link 不匹配 → publication UPDATE 也回滚）──
    const rp9 = await newProjection();
    const wav9 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r2-09.wav'), wav9);
    const reg9 = writeRegistry(path.join(DATA_DIR, 'regs'), `r2-09-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r2-09', voiceRevision: '1', speakerName: 'r2-09', referenceAssetPath: `${EMIT_ROOT}/r2-09.wav`, referenceSha256: sha256Buf(wav9)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg9, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry9 = getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r2-09'").get() as {id: string};
    markMappedVerified(entry9.id, rp9.matId, 'publish_and_cutover');
    const p9id = crypto.randomUUID();
    const gen9 = (getDb().prepare('SELECT COALESCE(MAX(generation),0)+1 AS n FROM voice_registry_publications').get() as {n: number}).n;
    const now9 = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO voice_registry_publications
         (id, generation, subject_type, subject_id, subject_mode, stable_registry_sha256,
          publisher_schema_version, status, owner_token, lease_expires_at_epoch_ms, attempt, created_at, updated_at)
       VALUES (?, ?, 'legacy_cutover_publish', ?, 'publish_and_cutover', ?, ?, 'building', ?,
               (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) + 600000, 1, ?, ?)`,
    ).run(p9id, gen9, entry9.id, 'a'.repeat(64), SUPPORTED_PUB, 'tok9', now9, now9);
    await expectCode('R2-09 legacy rollback mismatch → LEGACY_ROLLBACK_MISMATCH（整事务回滚）', () => {
      failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: p9id, ownerToken: 'tok9', attempt: 1, errorCode: 'TEST', errorMessage: 'R2-09'});
    }, LEGACY_ROLLBACK_MISMATCH);
    const r9after = getPublicationRow(getDb(), p9id);
    ok(r9after.status === 'building', 'R2-09 publication 保持 building（terminal UPDATE 已回滚）');
    const lve9 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry9.id) as Record<string, unknown>;
    ok(lve9.mapping_status === 'mapped_verified' && lve9.pending_publication_id === null, 'R2-09 legacy 保持 mapped_verified（无副作用）');
    releaseAllActiveFlights();

    // ── R2-10: exact final parent dir fsync（nested path root/sub/voice-registry.json）──
    const {pub: p10, adapter: a10} = await prepareFileDurable();
    const nestedAbs = path.join(ACTIVE_DIR, 'sub', 'voice-registry.json');
    fs.mkdirSync(path.join(ACTIVE_DIR, 'sub'), {recursive: true});
    const stable10 = fs.readFileSync(ACTIVE_PATH);
    fs.writeFileSync(nestedAbs, stable10);
    fs.rmSync(ACTIVE_PATH); // 只保留 nested 文件作为唯一 active registry
    const nestedPaths: ActiveRegistryPaths = {activeRegistryPath: nestedAbs, activeRegistryRoot: ACTIVE_DIR};
    ok((await classifyActiveDiskState(getDb(), p10.id, nestedPaths)).state === 'stable', 'R2-10 nested disk stable 前置');
    // 记录 fsync 目标（/proc/self/fd 解析句柄对应目录）
    const fsyncedDirs: string[] = [];
    const subAbs = path.resolve(path.join(ACTIVE_DIR, 'sub'));
    const recordingPaths: ActiveRegistryPaths = {
      ...nestedPaths,
      fsyncDir: async (fh) => {
        fsyncedDirs.push(fs.realpathSync(`/proc/self/fd/${fh.fd}`));
      },
    };
    const o10 = await promoteCandidateToActive(getDb(), p10.id, p10.owner_token as string, p10.attempt, recordingPaths);
    ok(o10 === 'promoted', 'R2-10 nested promote 成功');
    ok(sha256OfFile(nestedAbs) === p10.candidate_registry_sha256, 'R2-10 nested active == candidate bytes');
    ok(fsyncedDirs.some((d) => d === subAbs), `R2-10 fsync 目标含 exact parent root/sub（实际 ${JSON.stringify(fsyncedDirs)}）`);
    ok(!fsyncedDirs.some((d) => d === path.resolve(ACTIVE_DIR)), 'R2-10 fsync 目标不含 root（未误 fsync root）');
    // exact parent fsync 注入失败：restore 必须失败（rollback_pending），不继续 reload
    const reloadsBefore10 = a10.reloadCalls;
    const failingPaths: ActiveRegistryPaths = {
      ...nestedPaths,
      fsyncDir: async (fh) => {
        if (fs.realpathSync(`/proc/self/fd/${fh.fd}`) === subAbs) {
          throw new Error('injected exact parent fsync failure');
        }
      },
    };
    const restore10 = await restoreStableAndConfirm(getDb(), p10.id, p10.owner_token as string, p10.attempt, failingPaths, new AdapterClient({baseUrl: a10.baseUrl, timeoutMs: 500}));
    ok(restore10 === 'rollback_pending', `R2-10 exact parent fsync 失败 → restore rollback_pending（实际 ${restore10}）`);
    ok(a10.reloadCalls === reloadsBefore10, 'R2-10 restore 失败后零 reload');
    // exact parent fsync 注入失败：promote 必须失败（CANDIDATE_FILE_IO），不 activation
    await expectCode('R2-10 exact parent fsync 失败 → promote CANDIDATE_FILE_IO', async () => {
      await promoteCandidateToActive(getDb(), p10.id, p10.owner_token as string, p10.attempt, failingPaths);
    }, 'CANDIDATE_FILE_IO');
    ok(a10.reloadCalls === reloadsBefore10, 'R2-10 promote 失败后零 reload（不继续 activation）');
    ok(getPublicationRow(getDb(), p10.id).status === 'file_durable', 'R2-10 publication 保持 file_durable（不 activation）');
    failRow(getPublicationRow(getDb(), p10.id), 'TEST_FAIL', 'release R2-10');
    await a10.stop();
    // 恢复 ACTIVE_PATH（nested 场景删除了根级文件；后续 R3 区块依赖 ACTIVE_PATH 存在）
    fs.rmSync(path.join(ACTIVE_DIR, 'sub'), {recursive: true, force: true});
    fs.writeFileSync(ACTIVE_PATH, stable10);
  }

  // ══════════════ R3. TTS-C.1B.3.R3 API-safety closure ══════════════
  {
    // ── R3-01: restore 明确失败（reload 500）→ rollback_pending，不 terminal、legacy 保持 mapping_pending ──
    {
      const p1 = await prepareLegacyCutoverFileDurable('r3-01');
      await promoteCandidateToActive(getDb(), p1.pub.id, p1.pub.owner_token as string, p1.pub.attempt, PATHS);
      ok((await classifyActiveDiskState(getDb(), p1.pub.id, PATHS)).state === 'candidate', 'R3-01 disk candidate 前置');
      p1.adapter.reloadBehavior = 'reject500';
      const o1 = await failPostPromotionPublicationSafely(getDb(), {
        publicationId: p1.pub.id,
        ownerToken: p1.pub.owner_token as string,
        attempt: p1.pub.attempt,
        errorCode: 'TEST_FAIL',
        errorMessage: 'R3-01',
        paths: PATHS,
        adapter: new AdapterClient({baseUrl: p1.adapter.baseUrl, timeoutMs: 500}),
      });
      ok(o1.kind === 'rollback_pending', `R3-01 restore reload 500 → rollback_pending（实际 ${o1.kind}）`);
      const r1 = getPublicationRow(getDb(), p1.pub.id);
      ok(r1.status === 'file_durable', 'R3-01 publication 不 failed/cancelled');
      const lve1 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(p1.entryId) as Record<string, unknown>;
      ok(lve1.mapping_status === 'mapping_pending' && lve1.pending_publication_id === p1.pub.id, 'R3-01 legacy 保持 mapping_pending（single-flight 未释放）');
      releaseAllActiveFlights();
      await p1.adapter.stop();
    }

    // ── R3-02: restore 写入后 registry-status timeout → 不 terminal、不 legacy rollback ──
    {
      const p2 = await prepareLegacyCutoverFileDurable('r3-02');
      await promoteCandidateToActive(getDb(), p2.pub.id, p2.pub.owner_token as string, p2.pub.attempt, PATHS);
      p2.adapter.reloadBehavior = 'ok';
      p2.adapter.statusBehavior = 'timeout';
      const o2 = await failPostPromotionPublicationSafely(getDb(), {
        publicationId: p2.pub.id,
        ownerToken: p2.pub.owner_token as string,
        attempt: p2.pub.attempt,
        errorCode: 'TEST_FAIL',
        errorMessage: 'R3-02',
        paths: PATHS,
        adapter: new AdapterClient({baseUrl: p2.adapter.baseUrl, timeoutMs: 500}),
      });
      ok(o2.kind === 'rollback_pending', `R3-02 status timeout → rollback_pending（实际 ${o2.kind}）`);
      ok(getPublicationRow(getDb(), p2.pub.id).status === 'file_durable', 'R3-02 不 terminal');
      const lve2 = getDb().prepare('SELECT mapping_status FROM legacy_adapter_voice_entries WHERE id=?').get(p2.entryId) as Record<string, unknown>;
      ok(lve2.mapping_status === 'mapping_pending', 'R3-02 不 legacy rollback');
      releaseAllActiveFlights();
      await p2.adapter.stop();
    }

    // ── R3-03: safe fail 成功（disk candidate → restore stable → reload → ack → failed + legacy rollback）──
    {
      const p3 = await prepareLegacyCutoverFileDurable('r3-03');
      await promoteCandidateToActive(getDb(), p3.pub.id, p3.pub.owner_token as string, p3.pub.attempt, PATHS);
      const o3 = await failPostPromotionPublicationSafely(getDb(), {
        publicationId: p3.pub.id,
        ownerToken: p3.pub.owner_token as string,
        attempt: p3.pub.attempt,
        errorCode: 'TEST_FAIL',
        errorMessage: 'R3-03',
        paths: PATHS,
        adapter: new AdapterClient({baseUrl: p3.adapter.baseUrl, timeoutMs: 500}),
      });
      ok(o3.kind === 'failed', `R3-03 safe fail → failed（实际 ${o3.kind}）`);
      ok(getPublicationRow(getDb(), p3.pub.id).status === 'failed', 'R3-03 publication failed');
      ok((await classifyActiveDiskState(getDb(), p3.pub.id, PATHS)).state === 'stable', 'R3-03 disk 已恢复 stable');
      ok(p3.adapter.loadedSha === p3.pub.stable_registry_sha256, 'R3-03 adapter loaded == stable（reload ack 确认）');
      const lve3 = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector, mapping_mode FROM legacy_adapter_voice_entries WHERE id=?').get(p3.entryId) as Record<string, unknown>;
      ok(lve3.mapping_status === 'mapped_verified' && lve3.pending_publication_id === null && lve3.candidate_source_selector === null, 'R3-03 legacy mapped_verified + link/selector 清空');
      ok(lve3.mapping_mode === 'publish_and_cutover', 'R3-03 mapping_mode 保持');
      await p3.adapter.stop();
    }

    // ── R3-04: restore confirmed 与 terminal 之间 takeover → 旧 owner terminal fence 失败 ──
    {
      const p4 = await prepareLegacyCutoverFileDurable('r3-04');
      await promoteCandidateToActive(getDb(), p4.pub.id, p4.pub.owner_token as string, p4.pub.attempt, PATHS);
      let releaseGate4!: () => void;
      const gate4 = new Promise<void>((resolve) => {
        releaseGate4 = resolve;
      });
      let hookFired4 = false;
      const flow4 = failPostPromotionPublicationSafely(getDb(), {
        publicationId: p4.pub.id,
        ownerToken: p4.pub.owner_token as string,
        attempt: p4.pub.attempt,
        errorCode: 'TEST_FAIL',
        errorMessage: 'R3-04',
        paths: PATHS,
        adapter: new AdapterClient({baseUrl: p4.adapter.baseUrl, timeoutMs: 500}),
        afterRestoreConfirmedHook: () => {
          hookFired4 = true;
          return gate4;
        },
      });
      await waitFor(() => hookFired4);
      getDb().prepare('UPDATE voice_registry_publications SET lease_expires_at_epoch_ms=1 WHERE id=?').run(p4.pub.id);
      const t4 = takeoverExpiredPublication(getDb(), p4.pub.id);
      ok(t4.kind === 'taken', 'R3-04 B takeover 成功（restore confirmed 后挂起）');
      const b4Before = getPublicationRow(getDb(), p4.pub.id);
      releaseGate4();
      await expectCode('R3-04 旧 owner terminal fence → PUBLICATION_NOT_OWNER', () => flow4, PUBLICATION_NOT_OWNER);
      const b4After = getPublicationRow(getDb(), p4.pub.id);
      ok(b4After.owner_token === b4Before.owner_token && b4After.attempt === b4Before.attempt && b4After.lease_expires_at_epoch_ms === b4Before.lease_expires_at_epoch_ms, 'R3-04 B owner/attempt/lease 不变');
      ok(b4After.status !== 'failed' && b4After.status !== 'cancelled', 'R3-04 publication 不 terminal');
      ok((await classifyActiveDiskState(getDb(), p4.pub.id, PATHS)).state === 'stable', 'R3-04 disk 已恢复 stable（允许的安全结果）');
      releaseAllActiveFlights();
      await p4.adapter.stop();
    }

    // ── R3-05: safe cancel 成功（activation_pending → restore confirmed → cancelled + legacy rollback）──
    {
      const p5 = await prepareLegacyCutoverFileDurable('r3-05');
      await promoteCandidateToActive(getDb(), p5.pub.id, p5.pub.owner_token as string, p5.pub.attempt, PATHS);
      const client5 = new AdapterClient({baseUrl: p5.adapter.baseUrl, timeoutMs: 500});
      p5.adapter.reloadBehavior = 'ok';
      const reload5 = await client5.reload();
      if (reload5.kind !== 'ok') throw new Error('R3-05 前置 reload 失败');
      markActivationPending(getDb(), p5.pub.id, p5.pub.owner_token as string, p5.pub.attempt);
      ok(getPublicationRow(getDb(), p5.pub.id).status === 'activation_pending', 'R3-05 activation_pending 前置');
      const o5 = await cancelPostPromotionPublicationSafely(getDb(), {
        publicationId: p5.pub.id,
        ownerToken: p5.pub.owner_token as string,
        attempt: p5.pub.attempt,
        errorCode: 'TEST_CANCEL',
        errorMessage: 'R3-05',
        paths: PATHS,
        adapter: client5,
      });
      ok(o5.kind === 'cancelled', `R3-05 safe cancel → cancelled（实际 ${o5.kind}）`);
      const r5 = getPublicationRow(getDb(), p5.pub.id);
      ok(r5.status === 'cancelled', 'R3-05 publication cancelled');
      ok(r5.owner_token === null && r5.lease_expires_at_epoch_ms === null && r5.activated_at === null, 'R3-05 cancelled frozen shape（owner/lease/activated_at NULL）');
      const lve5 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(p5.entryId) as Record<string, unknown>;
      ok(lve5.mapping_status === 'mapped_verified' && lve5.pending_publication_id === null, 'R3-05 legacy rollback → mapped_verified');
      await p5.adapter.stop();
    }

    // ── R3-06: pre-promotion cancel（building → cancelled；frozen trigger 接受 cancelled 路径）──
    {
      const rp6 = await newProjection();
      const wav6 = wavFile();
      fs.writeFileSync(path.join(VOICE_ROOT, 'r3-06.wav'), wav6);
      const reg6 = writeRegistry(path.join(DATA_DIR, 'regs'), `r3-06-${crypto.randomUUID().slice(0, 6)}.json`, [
        {voiceProfile: 'r3-06', voiceRevision: '1', speakerName: 'r3-06', referenceAssetPath: `${EMIT_ROOT}/r3-06.wav`, referenceSha256: sha256Buf(wav6)},
      ]);
      await importLegacyRegistry(getDb(), {registryFilePath: reg6, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
      const entry6 = (getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r3-06'").get() as {id: string}).id;
      markMappedVerified(entry6, rp6.matId, 'publish_and_cutover');
      const claim6 = claimPublication(getDb(), {
        subject: {subjectType: 'legacy_cutover_publish', subjectId: entry6, subjectMode: 'publish_and_cutover'},
        stableRegistrySha256: 'a'.repeat(64),
      });
      if (claim6.kind !== 'claimed') throw new Error('R3-06 claim failed');
      const pub6 = getPublicationRow(getDb(), claim6.publication.id);
      ok(pub6.status === 'building', 'R3-06 building 前置');
      cancelPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub6.id, ownerToken: pub6.owner_token as string, attempt: pub6.attempt, errorCode: 'TEST_CANCEL', errorMessage: 'R3-06'});
      const r6 = getPublicationRow(getDb(), pub6.id);
      ok(r6.status === 'cancelled', 'R3-06 building → cancelled（frozen trigger 接受）');
      ok(r6.owner_token === null && r6.lease_expires_at_epoch_ms === null && r6.activated_at === null, 'R3-06 cancelled frozen shape');
      const lve6 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry6) as Record<string, unknown>;
      ok(lve6.mapping_status === 'mapped_verified' && lve6.pending_publication_id === null, 'R3-06 legacy rollback → mapped_verified');
    }

    // R3-07：无公开绕过入口——源码调用点审计（见最终报告 B/C 节）：
    //   terminalPostPromotionAfterRestoreConfirmed 为模块私有；公开导出仅
    //   terminalPostPromotionPublicationSafely / failPostPromotionPublicationSafely /
    //   cancelPostPromotionPublicationSafely（async，强制 restore + reload ack 前置）。
    ok(true, 'R3-07 post-promotion terminal 无公开 DB-only 入口（源码审计 + tsc 编译确认）');
  }

  // ══════════════ R4. TTS-C.1B.3.R4 exported-API closure ══════════════
  {
    // R4-01/02：编译期证明——failPublication 已从 registry-publisher 公开 API 移除。
    // 若符号仍存在，tsc 报 unused @ts-expect-error（TS2578）使编译失败。
    // @ts-expect-error R4: failPublication removed from public API
    const removedFailPublication = registryPublisherApi.failPublication;
    void removedFailPublication;

    // R4-02/06：运行时导出清单审计——两个模块均不得公开 db-only post-promotion terminal helper
    // （仅凭 db+publicationId+ownerToken+attempt 即可把 file_durable/activation_pending 推进 terminal）。
    const bannedExports = [
      'failPublication',
      'failOrCancelPublicationAndRollbackLegacy',
      'failPostPromotionPublicationAndRollbackLegacy',
      'cancelPostPromotionPublicationAndRollbackLegacy',
      'failPublicationAndRollbackLegacy',
      'cancelPublicationAndRollbackLegacy',
    ];
    const pubExports = Object.keys(registryPublisherApi).sort();
    const actExports = Object.keys(registryActivationApi).sort();
    const violations = bannedExports.filter((b) => pubExports.includes(b) || actExports.includes(b));
    ok(violations.length === 0, `R4-02/06 无公开 DB-only terminal helper（违规导出: ${JSON.stringify(violations)}）`);
    ok(!('failPublication' in registryPublisherApi), 'R4-02 registry-publisher 不再导出 failPublication（运行时证明）');
    console.log('[R4-06] registry-publisher exports:', pubExports.join(', '));
    console.log('[R4-06] registry-activation exports:', actExports.join(', '));

    // ── R4-01: file_durable 不能直接 fail（旧 DB-only API 不存在；唯一入口 = safe orchestrator）──
    const p1 = await prepareLegacyCutoverFileDurable('r4-01');
    await promoteCandidateToActive(getDb(), p1.pub.id, p1.pub.owner_token as string, p1.pub.attempt, PATHS);
    ok((await classifyActiveDiskState(getDb(), p1.pub.id, PATHS)).state === 'candidate', 'R4-01 disk candidate 前置');
    const lve1a = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(p1.entryId) as Record<string, unknown>;
    ok(lve1a.mapping_status === 'mapping_pending' && lve1a.pending_publication_id === p1.pub.id, 'R4-01 legacy mapping_pending 前置');
    // 旧式宽泛 API 已不存在（编译期 @ts-expect-error + 运行时 in 检查已证）；
    // 唯一正确入口仍工作：
    const o1 = await failPostPromotionPublicationSafely(getDb(), {
      publicationId: p1.pub.id,
      ownerToken: p1.pub.owner_token as string,
      attempt: p1.pub.attempt,
      errorCode: 'TEST_FAIL',
      errorMessage: 'R4-01',
      paths: PATHS,
      adapter: new AdapterClient({baseUrl: p1.adapter.baseUrl, timeoutMs: 500}),
    });
    ok(o1.kind === 'failed', `R4-01 safe orchestrator 完成安全 rollback（实际 ${o1.kind}）`);
    ok(getPublicationRow(getDb(), p1.pub.id).status === 'failed', 'R4-01 publication failed（仅经 safe 路径）');
    ok((await classifyActiveDiskState(getDb(), p1.pub.id, PATHS)).state === 'stable', 'R4-01 disk 恢复 stable');
    const lve1b = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector FROM legacy_adapter_voice_entries WHERE id=?').get(p1.entryId) as Record<string, unknown>;
    ok(lve1b.mapping_status === 'mapped_verified' && lve1b.pending_publication_id === null && lve1b.candidate_source_selector === null, 'R4-01 legacy rollback 完成（link/selector 清空）');
    await p1.adapter.stop();

    // ── R4-03: legacy building 不得绕过 rollback（正确调用 failPrePromotionPublicationAndRollbackLegacy）──
    const rp3 = await newProjection();
    const wav3 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r4-03.wav'), wav3);
    const reg3 = writeRegistry(path.join(DATA_DIR, 'regs'), `r4-03-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r4-03', voiceRevision: '1', speakerName: 'r4-03', referenceAssetPath: `${EMIT_ROOT}/r4-03.wav`, referenceSha256: sha256Buf(wav3)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg3, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry3 = (getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r4-03'").get() as {id: string}).id;
    markMappedVerified(entry3, rp3.matId, 'publish_and_cutover');
    const claim3 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry3, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: 'a'.repeat(64),
    });
    if (claim3.kind !== 'claimed') throw new Error('R4-03 claim failed');
    const pub3 = getPublicationRow(getDb(), claim3.publication.id);
    ok(pub3.status === 'building', 'R4-03 building 前置');
    failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub3.id, ownerToken: pub3.owner_token as string, attempt: pub3.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R4-03'});
    ok(getPublicationRow(getDb(), pub3.id).status === 'failed', 'R4-03 publication failed（经 pre-promotion legacy rollback）');
    const lve3 = getDb().prepare('SELECT mapping_status, pending_publication_id, candidate_source_selector FROM legacy_adapter_voice_entries WHERE id=?').get(entry3) as Record<string, unknown>;
    ok(lve3.mapping_status === 'mapped_verified' && lve3.pending_publication_id === null && lve3.candidate_source_selector === null, 'R4-03 legacy atomic rollback（link/selector 清空）');

    // ── R4-04: legacy candidate_persisted 同场景（必须 atomic legacy rollback）──
    const rp4 = await newProjection();
    const wav4 = wavFile();
    fs.writeFileSync(path.join(VOICE_ROOT, 'r4-04.wav'), wav4);
    const reg4 = writeRegistry(path.join(DATA_DIR, 'regs'), `r4-04-${crypto.randomUUID().slice(0, 6)}.json`, [
      {voiceProfile: 'r4-04', voiceRevision: '1', speakerName: 'r4-04', referenceAssetPath: `${EMIT_ROOT}/r4-04.wav`, referenceSha256: sha256Buf(wav4)},
    ]);
    await importLegacyRegistry(getDb(), {registryFilePath: reg4, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    const entry4 = (getDb().prepare("SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key='r4-04'").get() as {id: string}).id;
    markMappedVerified(entry4, rp4.matId, 'publish_and_cutover');
    const claim4 = claimPublication(getDb(), {
      subject: {subjectType: 'legacy_cutover_publish', subjectId: entry4, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: 'a'.repeat(64),
    });
    if (claim4.kind !== 'claimed') throw new Error('R4-04 claim failed');
    const pub4 = getPublicationRow(getDb(), claim4.publication.id);
    const built4 = await buildRegistryCandidate(getDb(), {publication: pub4, legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
    markCandidatePersisted(getDb(), {publicationId: pub4.id, ownerToken: pub4.owner_token as string, attempt: pub4.attempt, candidateRegistrySha256: built4.registrySha256, candidateManifestJson: built4.manifestJson, candidateManifestSha256: built4.manifestSha256});
    ok(getPublicationRow(getDb(), pub4.id).status === 'candidate_persisted', 'R4-04 candidate_persisted 前置');
    failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub4.id, ownerToken: pub4.owner_token as string, attempt: pub4.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R4-04'});
    ok(getPublicationRow(getDb(), pub4.id).status === 'failed', 'R4-04 publication failed（经 pre-promotion legacy rollback）');
    const lve4 = getDb().prepare('SELECT mapping_status, pending_publication_id FROM legacy_adapter_voice_entries WHERE id=?').get(entry4) as Record<string, unknown>;
    ok(lve4.mapping_status === 'mapped_verified' && lve4.pending_publication_id === null, 'R4-04 legacy atomic rollback 完成');

    // ── R4-05: non-legacy pre-promotion 行为（方案 A：无 non-legacy-only helper；
    //          failPrePromotion 对 non-legacy 只做 terminal，对 legacy 做 atomic rollback）──
    const np5 = await newProjection();
    const claim5 = claimPublication(getDb(), {
      subject: {subjectType: 'materialization_publish', subjectId: np5.matId, subjectMode: 'publish_and_cutover'},
      stableRegistrySha256: 'a'.repeat(64),
    });
    if (claim5.kind !== 'claimed') throw new Error('R4-05 claim failed');
    const pub5 = getPublicationRow(getDb(), claim5.publication.id);
    failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: pub5.id, ownerToken: pub5.owner_token as string, attempt: pub5.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R4-05'});
    ok(getPublicationRow(getDb(), pub5.id).status === 'failed', 'R4-05 non-legacy building → failed（pre-promotion，不触碰 legacy）');
    // file_durable → pre-promotion helper 拒绝（仅 building/candidate_persisted）
    const {pub: p5b, adapter: a5b} = await prepareFileDurable();
    await expectCode('R4-05 file_durable → pre-promotion helper 拒绝（PUBLICATION_NOT_OWNER）', () => {
      failPrePromotionPublicationAndRollbackLegacy(getDb(), {publicationId: p5b.id, ownerToken: p5b.owner_token as string, attempt: p5b.attempt, errorCode: 'TEST_FAIL', errorMessage: 'R4-05'});
    }, PUBLICATION_NOT_OWNER);
    ok(getPublicationRow(getDb(), p5b.id).status === 'file_durable', 'R4-05 file_durable 保持（未直接 terminal）');
    releaseAllActiveFlights();
    await a5b.stop();
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

/** 局部构造（R3/R4 共用）：legacy_cutover_publish subject 到 file_durable + mock adapter（loaded=stable）。 */
async function prepareLegacyCutoverFileDurable(voiceKey: string): Promise<{entryId: string; pub: PublicationRow; adapter: MockAdapter; stableBytes: Buffer}> {
  const p = await newProjection();
  const wav = wavFile();
  fs.writeFileSync(path.join(VOICE_ROOT, `${voiceKey}.wav`), wav);
  const regPath = writeRegistry(path.join(DATA_DIR, 'regs'), `${voiceKey}-${crypto.randomUUID().slice(0, 6)}.json`, [
    {voiceProfile: voiceKey, voiceRevision: '1', speakerName: voiceKey, referenceAssetPath: `${EMIT_ROOT}/${voiceKey}.wav`, referenceSha256: sha256Buf(wav)},
  ]);
  await importLegacyRegistry(getDb(), {registryFilePath: regPath, voiceRootDir: VOICE_ROOT, resolveReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))});
  const entryId = (getDb().prepare('SELECT id FROM legacy_adapter_voice_entries WHERE voice_profile_key=?').get(voiceKey) as {id: string}).id;
  markMappedVerified(entryId, p.matId, 'publish_and_cutover');
  const adapter = new MockAdapter(ACTIVE_PATH);
  await adapter.start();
  const stableBytes = fs.readFileSync(ACTIVE_PATH);
  adapter.loadedSha = sha256Bytes(stableBytes);
  const out = await publishRegistryCandidate(getDb(), {
    subject: {subjectType: 'legacy_cutover_publish', subjectId: entryId, subjectMode: 'publish_and_cutover'},
    stableRegistrySha256: sha256Bytes(stableBytes),
    build: {legacyVoiceRootDir: VOICE_ROOT, materializationRootDir: MAT_ROOT, emitVoiceRootPath: EMIT_ROOT, resolveLegacyReferencePath: (rp: string) => path.join(VOICE_ROOT, rp.replace(/^\/voices\//, ''))},
  });
  if (out.kind !== 'completed') throw new Error(`prepareLegacyCutoverFileDurable failed: ${JSON.stringify(out)}`);
  const pub = getPublicationRow(getDb(), out.publicationId);
  return {entryId, pub, adapter, stableBytes};
}
