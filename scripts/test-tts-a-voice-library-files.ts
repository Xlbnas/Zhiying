/**
 * TTS-A Voice Library — 安全（E）+ 文件/DB 一致性（G）测试。
 *
 * 覆盖（设计文档 docs/TTS_A_VOICE_LIBRARY_DESIGN.md §4 crash model / §6）：
 *  E. security：
 *     - 恶意 filename（路径穿越/绝对路径/shell metachar/换行/Unicode）→
 *       original_filename_display 被清洗（无路径分隔符/控制字符），磁盘上不出现客户端提供的路径
 *     - voice-library 根被替换为 symlink → ingest 失败（ingest_failed）
 *     - staging 文件 O_NOFOLLOW、不执行 shell（spawn 参数数组，无 sh -c / shell 选项）——源码断言
 *     - 不读 .env.production（voice-library 源码 grep 断言）；序列化出口不含 canonical_audio_path
 *  G. file/DB consistency（故障注入）：
 *     - staging 目录只读 → 写入失败、无 DB 行、无 staging 残留
 *     - commit 内 rename 失败（final 路径预置同名文件 → mkdir EEXIST → 事务回滚）→ 无 DB 行
 *     - ffprobe / ffmpeg 注入 fail → 无 DB 行无残留
 *     - crash-recovery：orphan reference.wav（无 DB 行）→ exact null、list 不含、再 ingest 不受影响
 *     - cleanup 语义：失败 ingest 的 staging 清理不删除 DB 引用文件
 *     - orphan 审计：DB 行指向缺失文件 → exact null（绝不返回 usable）
 *
 * 用法：npx tsx scripts/test-tts-a-voice-library-files.ts
 * 使用临时数据目录（data/test-tts-a-files），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-files');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {
  getVoiceProfileRevisionExact,
  ingestVoiceProfileRevision,
  listVoiceProfileRevisions,
  type VoiceLibraryExecDeps,
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

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function revisionCount(profileId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .get(profileId) as {c: number}).c;
}

function stagingEntries(): string[] {
  const staging = path.join(getDataDir(), 'voice-library', '.staging');
  if (!fs.existsSync(staging)) return [];
  return fs.readdirSync(staging);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const dataDir = getDataDir();
  const vlRoot = path.join(dataDir, 'voice-library');

  // ---------- E. security ----------

  // E1：恶意 filename —— 全部接受为 display metadata，但清洗后无路径分隔符/控制字符，
  //     且磁盘上不出现任何客户端提供的路径
  const pE = createVoiceProfile({displayName: '安全测试'});
  const nastyNames: Array<{name: string; freq: number}> = [
    {name: '../../etc/passwd', freq: 440},
    {name: '/etc/passwd', freq: 550},
    {name: 'a;rm -rf b.wav', freq: 620},
    {name: 'line1\nline2.wav', freq: 680},
    {name: '中文🎵.wav', freq: 770},
  ];
  const displays: Array<string | null> = [];
  for (const {name, freq} of nastyNames) {
    const r = await ingestVoiceProfileRevision({
      voiceProfileId: pE.id,
      requestId: `sec-${freq}`,
      audioBuffer: makeWav(1200, freq),
      originalFilename: name,
    });
    displays.push(r.revision.original_filename_display);
  }
  // eslint-disable-next-line no-control-regex
  const controlRe = /[\x00-\x1f\x7f]/;
  ok(
    displays.every((d) => d === null || (!d.includes('/') && !d.includes('\\') && !controlRe.test(d) && d.length <= 120)),
    '[E1] 恶意 filename 的 original_filename_display 均被清洗（无路径分隔符/控制字符，≤120）',
    displays,
  );
  ok(
    displays[4] === '中文🎵.wav',
    '[E2] 合法 Unicode 文件名原样保留（display metadata）',
    displays[4],
  );
  // 磁盘上只允许 zhiying.db* 与 voice-library/**；客户端提供的路径不得出现
  const allFiles = listFilesRecursive(dataDir).map((f) => path.relative(dataDir, f));
  const outside = allFiles.filter(
    (f) => !f.startsWith(`voice-library${path.sep}`) && !/^zhiying\.db(-wal|-shm)?$/.test(f),
  );
  ok(
    outside.length === 0 &&
      !fs.existsSync(path.join(dataDir, 'etc')) &&
      !fs.existsSync(path.resolve(dataDir, '..', 'etc', 'passwd')),
    '[E3] 磁盘上不出现客户端提供的路径（dataDir 内仅 zhiying.db* 与 voice-library/**）',
    outside,
  );

  // E2：voice-library 根被替换为 symlink → ingest 失败（ingest_failed）
  fs.rmSync(vlRoot, {recursive: true, force: true});
  const evilTarget = path.join(dataDir, 'evil-target');
  fs.mkdirSync(evilTarget, {recursive: true});
  fs.symlinkSync(evilTarget, vlRoot);
  const pS = createVoiceProfile({displayName: 'symlink 测试'});
  let symlinkErr: unknown = null;
  try {
    await ingestVoiceProfileRevision({
      voiceProfileId: pS.id,
      requestId: 'sec-symlink',
      audioBuffer: makeWav(1200, 440),
    });
  } catch (err) {
    symlinkErr = err;
  }
  ok(
    symlinkErr instanceof VoiceLibraryError && symlinkErr.code === 'ingest_failed' &&
      revisionCount(pS.id) === 0 && listFilesRecursive(evilTarget).length === 0,
    '[E4] voice-library 根为 symlink → ingest_failed(500)，无 DB 行、目标目录零写入',
    symlinkErr instanceof Error ? symlinkErr.message : String(symlinkErr),
  );
  fs.rmSync(vlRoot, {force: true}); // 删除 symlink 本身
  fs.rmSync(evilTarget, {recursive: true, force: true});

  // E3：源码安全断言 —— O_NOFOLLOW / 无 shell / 不读 .env.production / 序列化无路径
  const srcDir = path.resolve(process.cwd(), 'src/lib/voice-library');
  const revisionsSrc = fs.readFileSync(path.join(srcDir, 'revisions.ts'), 'utf8');
  const typesSrc = fs.readFileSync(path.join(srcDir, 'types.ts'), 'utf8');
  const allLibSrc = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'))
    .join('\n');
  const apiDir = path.resolve(process.cwd(), 'src/app/api/voice-profiles');
  const allApiSrc = listFilesRecursive(apiDir)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  ok(
    revisionsSrc.includes('O_NOFOLLOW') && revisionsSrc.includes('O_EXCL'),
    '[E5] staging 写入使用 O_CREAT|O_EXCL|O_NOFOLLOW（源码断言）',
  );
  ok(
    revisionsSrc.includes("from 'node:child_process'") && revisionsSrc.includes('execFile') &&
      !revisionsSrc.includes('shell:') && !allLibSrc.includes('sh -c') &&
      !allLibSrc.includes('execSync(') && !allLibSrc.includes('exec('),
    '[E6] ffprobe/ffmpeg 走参数数组 spawn（execFile），无 shell / sh -c（源码断言）',
  );
  ok(
    !allLibSrc.includes('.env.production') && !allApiSrc.includes('.env.production'),
    '[E7] voice-library lib 与 API 源码不读 .env.production（grep 断言）',
  );
  const serializeBlock = typesSrc.slice(typesSrc.indexOf('export function serializeRevision'));
  ok(
    !serializeBlock.includes('canonical_audio_path') && !serializeBlock.includes('metadata_json'),
    '[E8] serializeRevision 序列化出口不含 canonical_audio_path / metadata_json（API 无绝对路径的源码依据；运行时断言见 test-tts-a-voice-library-api.ts H34）',
  );

  // ---------- G. file/DB consistency ----------

  // G1：staging 目录只读 → 写入失败、无 DB 行、无 staging 残留
  const pG1 = createVoiceProfile({displayName: 'G1 只读 staging'});
  const stagingDir = path.join(vlRoot, '.staging');
  fs.mkdirSync(stagingDir, {recursive: true});
  fs.chmodSync(stagingDir, 0o555);
  let g1Err: unknown = null;
  try {
    await ingestVoiceProfileRevision({
      voiceProfileId: pG1.id,
      requestId: 'g1-req',
      audioBuffer: makeWav(1200, 440),
    });
  } catch (err) {
    g1Err = err;
  }
  fs.chmodSync(stagingDir, 0o755);
  ok(
    g1Err !== null && revisionCount(pG1.id) === 0 && stagingEntries().length === 0,
    '[G1] staging 目录只读 → ingest 失败、无 DB 行、无 staging 残留',
    g1Err instanceof Error ? g1Err.message : '未抛错',
  );

  // G2：commit 内 rename 失败（final 路径预置同名文件 → mkdir EEXIST → 事务回滚）→ 无 DB 行
  // rename 不可注入，用「profileDirAbs 已是文件」制造 commit 阶段必然失败：
  // mkdirSync(profileDirAbs) 在事务内 INSERT 之后抛错 → 事务回滚 → 无 DB 行。
  const pG2 = createVoiceProfile({displayName: 'G2 rename 失败'});
  fs.mkdirSync(vlRoot, {recursive: true});
  fs.writeFileSync(path.join(vlRoot, pG2.id), 'blocker'); // 与 profileDir 同名的文件
  let g2Err: unknown = null;
  try {
    await ingestVoiceProfileRevision({
      voiceProfileId: pG2.id,
      requestId: 'g2-req',
      audioBuffer: makeWav(1200, 440),
    });
  } catch (err) {
    g2Err = err;
  }
  const g2Rows = revisionCount(pG2.id);
  fs.rmSync(path.join(vlRoot, pG2.id), {force: true});
  ok(
    g2Err !== null && g2Rows === 0 && stagingEntries().length === 0,
    '[G2] commit 内 rename/mkdir 失败 → 事务回滚、无 DB 行、无 staging 残留',
    g2Err instanceof Error ? g2Err.message : '未抛错',
  );

  // G3：ffprobe / ffmpeg 注入 fail → 无 DB 行无残留
  const pG3 = createVoiceProfile({displayName: 'G3 注入失败'});
  const failFfprobe: VoiceLibraryExecDeps = {
    ffprobeImpl: async () => {
      throw new Error('injected ffprobe failure');
    },
  };
  const failFfmpeg: VoiceLibraryExecDeps = {
    ffmpegImpl: async () => {
      throw new Error('injected ffmpeg failure');
    },
  };
  let g3aErr: unknown = null;
  let g3bErr: unknown = null;
  try {
    await ingestVoiceProfileRevision(
      {voiceProfileId: pG3.id, requestId: 'g3a', audioBuffer: makeWav(1200, 440)},
      failFfprobe,
    );
  } catch (err) {
    g3aErr = err;
  }
  try {
    await ingestVoiceProfileRevision(
      {voiceProfileId: pG3.id, requestId: 'g3b', audioBuffer: makeWav(1200, 440)},
      failFfmpeg,
    );
  } catch (err) {
    g3bErr = err;
  }
  ok(
    g3aErr instanceof VoiceLibraryError && g3bErr instanceof VoiceLibraryError &&
      revisionCount(pG3.id) === 0 && stagingEntries().length === 0,
    '[G3] ffprobe / ffmpeg 注入 fail → 无 DB 行、无 staging 残留',
  );

  // G4：crash-recovery —— orphan reference.wav（无 DB 行）永不视为 usable，不影响后续 ingest
  const pG4 = createVoiceProfile({displayName: 'G4 orphan'});
  const orphanRid = '00000000-0000-0000-0000-000000000000';
  const orphanDir = path.join(vlRoot, pG4.id, orphanRid);
  fs.mkdirSync(orphanDir, {recursive: true});
  fs.writeFileSync(path.join(orphanDir, 'reference.wav'), makeWav(1200, 440));
  const orphanExact = await getVoiceProfileRevisionExact(pG4.id, orphanRid);
  const orphanList = listVoiceProfileRevisions(pG4.id);
  const afterOrphan = await ingestVoiceProfileRevision({
    voiceProfileId: pG4.id,
    requestId: 'g4-req',
    audioBuffer: makeWav(1200, 440),
  });
  ok(
    orphanExact === null && orphanList.length === 0 && afterOrphan.outcome === 'created' &&
      afterOrphan.revision.id !== orphanRid,
    '[G4] orphan final 文件（无 DB 行）→ exact null、list 不含、再次 ingest 不受影响（rid 服务端 UUID 不冲突）',
  );

  // G5：cleanup 语义 —— 失败 ingest 的 staging 清理不删除 DB 引用文件
  const pG5 = createVoiceProfile({displayName: 'G5 cleanup'});
  const good = await ingestVoiceProfileRevision({
    voiceProfileId: pG5.id,
    requestId: 'g5-good',
    audioBuffer: makeWav(1200, 440),
  });
  const goodAbs = path.join(dataDir, good.revision.canonical_audio_path);
  try {
    await ingestVoiceProfileRevision(
      {voiceProfileId: pG5.id, requestId: 'g5-bad', audioBuffer: makeWav(1200, 550)},
      failFfprobe,
    );
  } catch {
    // 预期失败
  }
  const goodStillUsable = await getVoiceProfileRevisionExact(pG5.id, good.revision.id);
  ok(
    fs.existsSync(goodAbs) && goodStillUsable !== null && goodStillUsable.usable === true &&
      stagingEntries().length === 0,
    '[G5] 失败 ingest 的 staging finally 清理不删除 DB 引用文件（正常 revision 仍 usable）',
  );

  // G6：orphan 审计 —— DB 行指向缺失文件 → exact null（绝不返回 usable）
  fs.rmSync(goodAbs);
  const missing = await getVoiceProfileRevisionExact(pG5.id, good.revision.id);
  ok(
    missing === null,
    '[G6] DB 行指向缺失文件 → exact null（不存在「行在、文件缺、却返回 usable」的情形）',
  );

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A files 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A Voice Library files（安全+文件/DB 一致性）测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});
