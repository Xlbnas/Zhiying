/**
 * TTS-C.1A.R1 真实 filesystem containment（P0-3）——真实 symlink/swap/root 场景：
 * - PATH-01 source final component symlink → reject（O_NOFOLLOW open 失败）；
 * - PATH-02 source lstat 后、open 前 symlink swap → reject（O_NOFOLLOW open 失败）；
 * - PATH-03 materialization root symlink → reject；
 * - PATH-04 profile directory symlink outside root → reject；
 * - PATH-05 revision directory symlink outside root → reject；
 * - PATH-06 final file symlink → reject（O_NOFOLLOW）；
 * - PATH-07 temp symlink precreate → O_EXCL|O_NOFOLLOW reject；
 * - PATH-08 parent realpath outside root → reject；
 * - PATH-09 合法目录链成功（含 O_NOFOLLOW 读写）；
 * - PATH-10 cleanup 不跟随 symlink（temp 清理仅删自身路径）。
 * 全部为真实 fs 操作（非纯字符串断言）。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture} from './lib/tts-c1a-test-utils';
import {
  ensureMaterializationRootSafe,
  ensureExistingDestinationParentSafe,
  destinationAbsolutePath,
  stagingTempPath,
  OPEN_FLAGS,
  ProjectionPathError,
} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-path-security';
let fx: C1aFixture;

(async () => {
  fx = await setupC1aFixture(TAG);
  const rootAbs = path.join(fx.dataDir, 'voice-materializations');
  const rel = `${fx.profileId}/${fx.revisionId}/reference.wav`;
  const outside = path.join(fx.dataDir, 'outside-target');
  fsSync.mkdirSync(outside, {recursive: true});

  // PATH-03：materialization root symlink → reject
  fsSync.mkdirSync(rootAbs, {recursive: true});
  const fakeRoot = path.join(fx.dataDir, 'fake-root-link');
  fsSync.rmSync(fakeRoot, {force: true});
  fsSync.symlinkSync(rootAbs, fakeRoot);
  try {
    await ensureMaterializationRootSafe(fakeRoot);
    ok(false, 'PATH-03 root symlink → reject', 'no error');
  } catch (e) {
    ok(e instanceof ProjectionPathError && e.message.includes('symlink'), 'PATH-03 root symlink → reject', e);
  }

  // PATH-04：profile directory symlink outside root → reject
  fsSync.mkdirSync(rootAbs, {recursive: true}); // existing 版不 mkdir——测试先建 root
  const profId = fx.profileId;
  const revId = fx.revisionId;
  const profDir = path.join(rootAbs, profId);
  // 先建真实 revision 目录，再把 profile 换 symlink（模拟攻击）
  fsSync.mkdirSync(path.join(profDir, revId), {recursive: true});
  fsSync.rmSync(profDir, {recursive: true, force: true});
  fsSync.symlinkSync(outside, profDir);
  try {
    await ensureExistingDestinationParentSafe(rootAbs, rel);
    ok(false, 'PATH-04 profile symlink → reject', 'no error');
  } catch (e) {
    ok(e instanceof ProjectionPathError && e.message.includes('symlink'), 'PATH-04 profile symlink outside root → reject', e);
  }

  // PATH-05：revision directory symlink outside root → reject
  fsSync.rmSync(profDir, {recursive: true, force: true});
  fsSync.mkdirSync(profDir, {recursive: true});
  fsSync.symlinkSync(outside, path.join(profDir, revId));
  try {
    await ensureExistingDestinationParentSafe(rootAbs, rel);
    ok(false, 'PATH-05 revision symlink → reject', 'no error');
  } catch (e) {
    ok(e instanceof ProjectionPathError && e.message.includes('symlink'), 'PATH-05 revision symlink outside root → reject', e);
  }

  // PATH-08：parent realpath outside root → reject（revision 目录指向 root 外）
  fsSync.rmSync(path.join(profDir, revId), {force: true});
  fsSync.symlinkSync(path.join(fx.dataDir, '..'), path.join(profDir, revId));
  try {
    await ensureExistingDestinationParentSafe(rootAbs, rel);
    ok(false, 'PATH-08 parent realpath outside root → reject', 'no error');
  } catch (e) {
    ok(e instanceof ProjectionPathError, 'PATH-08 parent realpath outside root → reject', e);
  }

  // PATH-09：合法目录链成功（realpath 包含性 + O_NOFOLLOW 写读；existing 版不 mkdir——先建目录）
  fsSync.rmSync(path.join(profDir, revId), {force: true});
  fsSync.mkdirSync(path.join(profDir, revId), {recursive: true});
  const safe = await ensureExistingDestinationParentSafe(rootAbs, rel);
  ok(safe.realRoot === fsSync.realpathSync(rootAbs) && safe.realParent.startsWith(safe.realRoot + path.sep), 'PATH-09 合法目录链 realpath 包含', {root: safe.realRoot, parent: safe.realParent});
  const finalAbs = destinationAbsolutePath(rel);
  const tmp = stagingTempPath(finalAbs);
  const fh = await fs.open(tmp, OPEN_FLAGS.tempCreate);
  await fh.write(Buffer.from('hello'));
  await fh.sync();
  await fh.close();
  await fs.rename(tmp, finalAbs);
  const rfh = await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
  const st = await rfh.stat();
  ok(st.isFile() && !st.isSymbolicLink(), 'PATH-09 O_NOFOLLOW 读取 final 成功', st.isFile());
  await rfh.close();

  // PATH-06：final file symlink → reject（O_NOFOLLOW open 失败）
  fsSync.rmSync(finalAbs, {force: true});
  fsSync.symlinkSync(outside, finalAbs);
  try {
    await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
    ok(false, 'PATH-06 final symlink → reject', 'no error');
  } catch (e) {
    ok((e as NodeJS.ErrnoException)?.code === 'ELOOP' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR' || (e as NodeJS.ErrnoException)?.code === 'EINVAL', 'PATH-06 final symlink → O_NOFOLLOW reject', e);
  }

  // PATH-07：temp symlink precreate → O_EXCL|O_NOFOLLOW reject
  fsSync.rmSync(finalAbs, {force: true});
  const tmp2 = stagingTempPath(finalAbs);
  fsSync.symlinkSync(outside, tmp2);
  try {
    await fs.open(tmp2, OPEN_FLAGS.tempCreate);
    ok(false, 'PATH-07 temp symlink precreate → reject', 'no error');
  } catch (e) {
    ok((e as NodeJS.ErrnoException)?.code === 'EEXIST', 'PATH-07 temp symlink precreate → O_EXCL reject', e);
  }

  // PATH-01：source final component symlink → reject（O_NOFOLLOW open 失败）
  const srcAbs = path.join(fx.dataDir, 'voice-library', fx.profileId, fx.revisionId, 'reference.wav');
  const savedSrc = fsSync.readFileSync(srcAbs);
  fsSync.rmSync(srcAbs, {force: true});
  fsSync.symlinkSync(outside, srcAbs);
  try {
    await fs.open(srcAbs, OPEN_FLAGS.readNoFollow);
    ok(false, 'PATH-01 source symlink → reject', 'no error');
  } catch (e) {
    ok((e as NodeJS.ErrnoException)?.code === 'ELOOP' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR', 'PATH-01 source symlink → O_NOFOLLOW reject', e);
  }
  fsSync.rmSync(srcAbs, {force: true});
  fsSync.writeFileSync(srcAbs, savedSrc);

  // PATH-02：source lstat 后、open 前 symlink swap → reject（O_NOFOLLOW open 失败）
  const srcSwap = path.join(fx.dataDir, 'voice-library', fx.profileId, fx.revisionId, 'reference.wav');
  const stBefore = await fs.lstat(srcSwap);
  ok(stBefore.isFile() && !stBefore.isSymbolicLink(), 'PATH-02 前置 lstat 正常（随后 swap）');
  fsSync.rmSync(srcSwap, {force: true});
  fsSync.symlinkSync(outside, srcSwap);
  try {
    await fs.open(srcSwap, OPEN_FLAGS.readNoFollow);
    ok(false, 'PATH-02 swap 后 O_NOFOLLOW open → reject', 'no error');
  } catch (e) {
    ok((e as NodeJS.ErrnoException)?.code === 'ELOOP' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR', 'PATH-02 lstat 后 symlink swap → open reject', e);
  }
  fsSync.rmSync(srcSwap, {force: true});
  fsSync.writeFileSync(srcSwap, savedSrc);

  // PATH-10：cleanup 不跟随 symlink（temp 清理只删自身路径；symlink 的 temp 路径删除只删链接本身）
  const tmp3 = stagingTempPath(finalAbs);
  fsSync.symlinkSync(outside, tmp3);
  await fs.rm(tmp3, {force: true}); // cleanup 语义 = rm(自身路径)
  ok(!fsSync.existsSync(tmp3) && fsSync.existsSync(outside), 'PATH-10 cleanup 删除 temp 链接本身、不触碰目标', {tmp: fsSync.existsSync(tmp3), outside: fsSync.existsSync(outside)});

  cleanupC1a(TAG);
  summary('TTS-C.1A path-security');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
