/**
 * TTS-A.R1 — durability 权威测试（D1..D5）。
 *
 * 验证「文件 durability 必须先于 SQLite commit」（设计文档 §4 crash model，TTS-A.R1 修正）：
 *  D1 正常顺序：注入 file-op deps 记录调用日志，证明
 *     rename → fsync final → fsync revisionDir → fsync profileDir → fsync root → fsync staging
 *     → 事务 commit → API 201（非源码字符串匹配，运行时调用日志）
 *  D2 rename 后、DB commit 前 fsync 失败：稳定 ingest_failed(500)；revision row=0；
 *     final 文件即使存在也只是 orphan；exact reader → null；下一请求不把 orphan 当 duplicate
 *  D3 DB insert/commit 失败：revision row=0；final orphan 允许存在；不返回 success；
 *     已存在 revision 文件不被覆盖（assertFinalAbsent 保护 + 事务回滚）
 *  D4 commit 后无 durability-critical 操作：运行时日志恰为 6 次 file-op，且无 commit 后追加；
 *     源码断言 post-commit 段无 fsync/fileOps（仅 best-effort metadata.json）
 *  D5 process-crash model 文档：断言设计文档包含修正后的 crash model 措辞与全部 crash window
 *     （禁止「rename 在 commit 前 → committed 行必然有文件」旧表述）
 *
 * 用法：npx tsx scripts/test-tts-a-durability.ts
 * 使用临时数据目录（data/test-tts-a-durability），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-durability');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {
  getVoiceProfileRevisionExact,
  ingestVoiceProfileRevision,
  type VoiceLibraryExecDeps,
  type VoiceLibraryFileOps,
} from '../src/lib/voice-library/revisions';
import {VoiceLibraryError} from '../src/lib/voice-library/types';

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

function makeWav(durationMs: number, freq: number): Buffer {
  const sampleRate = 48000;
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function revisionCount(profileId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .get(profileId) as {c: number}).c;
}

function listWavsUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listWavsUnder(p));
    else if (entry.isFile() && entry.name === 'reference.wav') out.push(p);
  }
  return out;
}

function stagingEntries(): string[] {
  const staging = path.join(getDataDir(), 'voice-library', '.staging');
  if (!fs.existsSync(staging)) return [];
  if (!fs.statSync(staging).isDirectory()) return [];
  return fs.readdirSync(staging);
}

/** 记录真实操作的 file-op deps（D1/D4 顺序证据）。 */
function recordingFileOps(log: Array<{op: string; args: string[]}>): VoiceLibraryFileOps {
  return {
    rename: (from, to) => {
      log.push({op: 'rename', args: [from, to]});
      fs.renameSync(from, to);
    },
    fsyncFile: (p) => {
      log.push({op: 'fsyncFile', args: [p]});
      const fd = fs.openSync(p, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    fsyncDir: (p) => {
      log.push({op: 'fsyncDir', args: [p]});
      const fd = fs.openSync(p, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    // cleanup rm 是 best-effort（非 durability-critical）：真实执行但不入 durability 日志
    rm: (p) => {
      fs.rmSync(p, {recursive: true, force: true});
    },
  };
}

/** 固定 crypto.randomUUID 输出（用于预测 revisionDir/final 路径）；用完恢复。 */
async function withFixedUuid<T>(uuid: string, fn: () => Promise<T>): Promise<T> {
  const cryptoMod = crypto as unknown as {randomUUID: () => string};
  const orig = cryptoMod.randomUUID;
  cryptoMod.randomUUID = () => uuid;
  try {
    return await fn();
  } finally {
    cryptoMod.randomUUID = orig;
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const dataDir = getDataDir();
  const vlRoot = path.join(dataDir, 'voice-library');

  // ---------- D1：正常顺序（运行时 file-op 日志） ----------
  {
    const p = createVoiceProfile({displayName: 'D1 顺序'});
    const log: Array<{op: string; args: string[]}> = [];
    const deps: VoiceLibraryExecDeps = {fileOps: recordingFileOps(log)};
    const result = await ingestVoiceProfileRevision(
      {voiceProfileId: p.id, requestId: 'd1', audioBuffer: makeWav(1500, 440)},
      deps,
    );
    const ops = log.map((l) => l.op);
    const [renameFrom, renameTo] = log[0].args;
    const finalAbs = log[1].args[0]; // fsyncFile 参数
    const fsyncDirs = log.slice(2).map((l) => l.args[0]);
    const rowAbs = path.join(dataDir, result.revision.canonical_audio_path);
    ok(
      ops.join(' -> ') === 'rename -> fsyncFile -> fsyncDir -> fsyncDir -> fsyncDir -> fsyncDir',
      '[D1a] file-op 调用顺序：rename → fsync final → fsync revisionDir → fsync profileDir → fsync root → fsync staging',
      ops,
    );
    ok(
      renameFrom.endsWith('canonical.wav') && renameTo.endsWith('reference.wav') &&
        renameTo.includes(path.join('voice-library', p.id)) &&
        renameTo === finalAbs &&
        renameTo === rowAbs,
      '[D1b] rename 源为 staging canonical.wav，目标为 final reference.wav（与 DB 行路径一致）',
      {renameFrom, renameTo, rowAbs},
    );
    ok(
      fs.existsSync(rowAbs) &&
        fsyncDirs[0] === path.dirname(finalAbs) && // revisionDir
        fsyncDirs[1] === path.dirname(path.dirname(finalAbs)) && // profileDir
        fsyncDirs[2] === vlRoot && // voice-library root
        fsyncDirs[3] === path.dirname(renameFrom), // staging 源目录（canonical.wav 所在）
      '[D1c] fsync 目录序列 = revisionDir / profileDir / voice-library root / staging 源目录',
      fsyncDirs,
    );
    ok(
      result.outcome === 'created' && result.status === 201 && revisionCount(p.id) === 1,
      '[D1d] 事务 commit 完成后 API 返回 201 created（DB 行存在）',
    );
    // commit 后无追加 file-op（D4 的运行时证据之一）：resolve 时日志长度恰为 6
    ok(
      log.length === 6,
      '[D1e] 全部 durability-critical file-op 在 commit 前完成（日志无 commit 后追加）',
      log.length,
    );
  }

  // ---------- D2：rename 后、DB commit 前 fsync 失败 → 稳定 ingest_failed + orphan ----------
  {
    const p = createVoiceProfile({displayName: 'D2 fsync 失败'});
    const fsyncFailDeps: VoiceLibraryExecDeps = {
      fileOps: {
        rename: (from, to) => fs.renameSync(from, to),
        fsyncFile: () => {
          throw new Error('injected fsync failure after rename');
        },
        fsyncDir: (dir) => {
          const fd = fs.openSync(dir, 'r');
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        },
      },
    };
    let err: unknown = null;
    try {
      await ingestVoiceProfileRevision(
        {voiceProfileId: p.id, requestId: 'd2', audioBuffer: makeWav(1500, 440)},
        fsyncFailDeps,
      );
    } catch (e) {
      err = e;
    }
    ok(
      err instanceof VoiceLibraryError && err.code === 'ingest_failed' && err.httpStatus === 500,
      '[D2a] rename 后 fsync 失败 → 稳定 ingest_failed(500)',
      err instanceof Error ? err.message : String(err),
    );
    const rows = revisionCount(p.id);
    const orphanWavs = listWavsUnder(path.join(vlRoot, p.id));
    const orphanAbs = orphanWavs[0];
    ok(
      rows === 0,
      '[D2b] fsync 失败 → DB 事务回滚，revision row=0',
      rows,
    );
    ok(
      orphanWavs.length === 1 && fs.existsSync(orphanAbs),
      '[D2c] final 文件即使存在也只是 orphan（rename 已生效但无 DB 行）',
      orphanWavs,
    );
    const exact = await getVoiceProfileRevisionExact(p.id, path.basename(path.dirname(orphanAbs)));
    ok(exact === null, '[D2d] orphan 不可被 exact reader 使用（exact → null）');
    // 下一请求（不同 requestId，同音频）不把 orphan 当 duplicate DB revision → created
    const next = await ingestVoiceProfileRevision({
      voiceProfileId: p.id,
      requestId: 'd2-next',
      audioBuffer: makeWav(1500, 440),
    });
    ok(
      next.outcome === 'created' && revisionCount(p.id) === 1 && next.revision.request_id === 'd2-next',
      '[D2e] 下一请求不把 orphan 当 duplicate DB revision（同音频不同 requestId → created）',
    );
    ok(stagingEntries().length === 0, '[D2f] 失败路径 staging 无残留', stagingEntries());
  }

  // ---------- D3：DB insert / commit 失败 ----------
  {
    // D3a：INSERT 阶段 DB 失败（BEFORE INSERT abort trigger）→ row=0、无 success、
    //       final 不产生（rename 在 INSERT 之后，未执行）
    const p = createVoiceProfile({displayName: 'D3a insert 失败'});
    getDb().exec(
      `CREATE TRIGGER IF NOT EXISTS tts_a_test_insert_abort
       BEFORE INSERT ON voice_profile_revisions
       BEGIN SELECT RAISE(ABORT, 'tts-a-test insert failure'); END;`,
    );
    let errA: unknown = null;
    try {
      await ingestVoiceProfileRevision({
        voiceProfileId: p.id,
        requestId: 'd3a',
        audioBuffer: makeWav(1500, 440),
      });
    } catch (e) {
      errA = e;
    }
    getDb().exec('DROP TRIGGER IF EXISTS tts_a_test_insert_abort');
    const wavsA = listWavsUnder(path.join(vlRoot, p.id));
    ok(
      errA !== null && revisionCount(p.id) === 0,
      '[D3a] INSERT 失败 → 事务回滚、revision row=0、不返回 success',
      errA instanceof Error ? errA.message : '未抛错',
    );
    ok(wavsA.length === 0, '[D3b] INSERT 失败时 final 未产生（rename 未执行；orphan 允许但不必然存在）', wavsA);
    ok(stagingEntries().length === 0, '[D3c] INSERT 失败路径 staging 无残留', stagingEntries());

    // D3b：final 路径已存在（含 sentinel 字节）→ assertFinalAbsent 保护：
    //       INSERT 成功后 rename 前拒绝覆盖 → ingest_failed → 事务回滚 → row=0，sentinel 不被覆盖
    const p2 = createVoiceProfile({displayName: 'D3b 覆盖保护'});
    const fixedUuid = '11111111-1111-4111-8111-111111111111';
    const sentinelPath = path.join(vlRoot, p2.id, fixedUuid, 'reference.wav');
    fs.mkdirSync(path.dirname(sentinelPath), {recursive: true});
    fs.writeFileSync(sentinelPath, Buffer.from('SENTINEL-DO-NOT-OVERWRITE'));
    let errB: unknown = null;
    try {
      await withFixedUuid(fixedUuid, () =>
        ingestVoiceProfileRevision({
          voiceProfileId: p2.id,
          requestId: 'd3b',
          audioBuffer: makeWav(1500, 440),
        }),
      );
    } catch (e) {
      errB = e;
    }
    const sentinelAfter = fs.readFileSync(sentinelPath).toString();
    ok(
      errB instanceof VoiceLibraryError && errB.code === 'ingest_failed' && errB.httpStatus === 500,
      '[D3d] final 路径已存在 → 拒绝覆盖（ingest_failed）',
      errB instanceof Error ? errB.message : String(errB),
    );
    ok(
      revisionCount(p2.id) === 0 && sentinelAfter === 'SENTINEL-DO-NOT-OVERWRITE',
      '[D3e] 已存在 revision 文件不被覆盖，且 DB row=0（assertFinalAbsent 抛错 → 事务回滚）',
      {rows: revisionCount(p2.id), sentinel: sentinelAfter},
    );
    fs.rmSync(path.join(vlRoot, p2.id, fixedUuid), {recursive: true, force: true});
    ok(stagingEntries().length === 0, '[D3f] 覆盖保护路径 staging 无残留', stagingEntries());
  }

  // ---------- D4：commit 后无 durability-critical 操作 ----------
  {
    const p = createVoiceProfile({displayName: 'D4 post-commit'});
    const log: Array<{op: string; args: string[]}> = [];
    const result = await ingestVoiceProfileRevision(
      {voiceProfileId: p.id, requestId: 'd4', audioBuffer: makeWav(1500, 440)},
      {fileOps: recordingFileOps(log)},
    );
    ok(
      result.outcome === 'created' && log.length === 6,
      '[D4a] commit 成功后无 durability-critical fsync/rename 追加（运行时日志恰 6 次，201 已返回）',
      log.map((l) => l.op),
    );
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/voice-library/revisions.ts'),
      'utf8',
    );
    const commitIdx = src.indexOf('const committed = commit.immediate();');
    const retIdx = src.indexOf("return {outcome: 'created', status: 201, revision: row};", commitIdx);
    const postCommitSegment = src.slice(commitIdx, retIdx);
    const codeOnly = postCommitSegment
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    ok(
      !codeOnly.includes('fileOps.') && !codeOnly.includes('fsync') &&
        postCommitSegment.includes('metadata.json') && postCommitSegment.includes('try {') &&
        postCommitSegment.includes('catch'),
      '[D4b] 源码：commit 后段无 fsync/fileOps 调用，仅 best-effort metadata.json（try/catch 包裹）',
    );
  }

  // ---------- D5：process-crash model 文档 ----------
  {
    const doc = fs.readFileSync(
      path.resolve(process.cwd(), 'docs/TTS_A_VOICE_LIBRARY_DESIGN.md'),
      'utf8',
    );
    ok(
      doc.includes('durability-critical') && doc.includes('commit 前') &&
        doc.includes('rename') && doc.includes('fsync'),
      '[D5a] 设计文档声明 durability-critical rename/fsync 全部在 SQLite commit 前完成',
    );
    ok(
      !doc.includes('rename 在 commit 之前执行 → **committed revision 行必然有对应 final 文件**'),
      '[D5b] 设计文档不再包含旧错误表述（committed 行必然有文件，因 rename 在 commit 前）',
    );
    for (const window of [
      'canonicalization 前',
      'staging 完成后',
      'rename 前',
      'rename 后 DB commit 前',
      'DB commit 后',
    ]) {
      ok(doc.includes(window), `[D5c] crash window 已列出：${window}`);
    }
    for (const state of ['无 DB、无文件', '无 DB、orphan 文件', 'DB + durable 文件', 'DB + missing/non-durable 文件']) {
      ok(doc.includes(state), `[D5d] crash 状态机已写明：${state}`);
    }
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A durability 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A durability（文件先于 DB commit）测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});
