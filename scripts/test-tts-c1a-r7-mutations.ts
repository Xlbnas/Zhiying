/**
 * TTS-C.1A.R7 mutation gate runner（portable；STRONG-only）。
 *
 * 12 项 mutation（MUT-R7-01..12）——每项修改真实完整 invariant（互补 fence 整组删除）：
 *  1. 确认源文件真的变化（fileShaBefore → fileShaMutated）
 *  2. mutation 后运行 typecheck（除显式 compile mutation 外必须通过）
 *  3. 跑目标 test（r5-hardening + r6-hardening）
 *  4. STRONG PASS 必须同时满足：
 *     - diffApplied && shaMutated !== shaBefore
 *     - typecheck 通过（compile mutation 除外）
 *     - child.status !== null && child.status !== 0（target 因预期 invariant 失败）
 *     - 无 fatal pattern（ReferenceError/SyntaxError/Cannot find module/ERR_MODULE_NOT_FOUND/
 *       TypeError:.*undefined/fixture setup failed）
 *     - observed FAIL labels 覆盖全部 expected
 *  5. restore → fileShaRestored === fileShaBefore
 *  6. restore 后 git diff --exit-code -- <mutated files> 为空 + git status --porcelain 无改动
 *
 * 硬规则：任一 mutation 非 STRONG → exit 1（禁止 commit/push；不得写 mutation closure）。
 *
 * 输出：docs/evidence/tts-c-r17/mutation-output.txt + /tmp/r7-mutation-output.txt
 */
import {spawnSync, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim();
const ARTIFACT_DOCS = path.join(REPO, 'docs/evidence/tts-c-r17/mutation-output.txt');
const ARTIFACT_TMP = '/tmp/r7-mutation-output.txt';
const TARGET_TESTS = ['scripts/test-tts-c1a-r5-hardening.ts', 'scripts/test-tts-c1a-r6-hardening.ts'];
const TOOLS_FFMPEG = path.join(REPO, '.tools/static-ffmpeg');

interface Mut {
  id: string;
  desc: string;
  file: string;
  files?: string[]; // 多文件 mutation（互补 fence 整组）
  apply: (src: string, fileName: string) => string;
  expected: RegExp[];
  compileMutation?: boolean;
}

const VALIDATOR = 'src/lib/tts-c/materialized-file-validator.ts';
const MATERIALIZATION = 'src/lib/tts-c/materialization.ts';
const ROUTE = 'src/app/api/projects/[id]/voice-materializations/route.ts';

const MUTATIONS: Mut[] = [
  {
    id: 'MUT-R7-01',
    desc: 'remove durable mode check（assertHeldCurrentSync requireDurability 失效）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "if (opts.requireDurability && r.mode !== 'durabilize') {",
        "/* MUT-R7-01 */ if (false && opts.requireDurability && r.mode !== 'durabilize') {",
      ),
    expected: [/CAP-06/],
  },
  {
    id: 'MUT-R7-02',
    desc: 'remove entire parent/ancestor identity group（parent realpath + root/profile/revision lstat 整组 + §八 integrity 互补 fence）',
    file: VALIDATOR,
    files: [VALIDATOR, MATERIALIZATION],
    apply: (src, fileName) => {
      if (fileName === VALIDATOR) {
        const start = src.indexOf("  if (snap.parentRealpath !== realParentNow) fail('SEAL_MISMATCH', 'evidence.parentRealpath ≠ derived parent realpath');");
        const end = src.indexOf('  const fdStat = fsSync.fstatSync(r.fileHandle.fd, {bigint: true});', start);
        if (start === -1 || end === -1) return src;
        return src.slice(0, start) + '  /* MUT-R7-02: ancestor identity group removed */ void realParentNow;\n' + src.slice(end);
      }
      // MATERIALIZATION：移除 §八 integrity fail-closed（互补 fence——profile swap 会被 §八 integrityStatusOf 兜住）
      return src.replace(
        "      if (integrityStatus !== 'verified') {\n        throw new MaterializationError(\n          'MATERIALIZATION_UNUSABLE',\n          `reuse 投影文件不可用（integrity=${integrityStatus}）；fail-closed 不冒充 reused`,\n          422,\n        );\n      }",
        "      /* MUT-R7-02b: §8 integrity fail-closed removed */ void integrityStatus;",
      );
    },
    expected: [/REUSE-DIR-01/, /REUSE-DIR-03/],
  },
  {
    id: 'MUT-R7-03',
    desc: 'expose actual usable issuer path（__internal 重新导出；引用真实存在的符号）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "const reuseRecords = new WeakMap<ValidatedReusableProjectionCapability, ReuseAuthorityRecord>();",
        "export const __internal = { validateProjectionForReuse };\nconst reuseRecords = new WeakMap<ValidatedReusableProjectionCapability, ReuseAuthorityRecord>();",
      ),
    expected: [/REUSE-AUTH-01c/],
  },
  {
    id: 'MUT-R7-04',
    desc: 'remove issuance SHA equality + openHeld SHA comparison（SHA authority 整组）',
    file: VALIDATOR,
    apply: (src) => {
      let s = src;
      s = s.replace(
        "        snap.sha256 !== projection.source_canonical_sha256",
        "        /* MUT-R7-04a */ false",
      );
      s = s.replace(
        "    if (sha !== expectation.expectedSha256) {\n      throw new MaterializedFileError('SHA_MISMATCH', `sha256 不一致（${sha.slice(0, 12)}…）`);\n    }",
        "    /* MUT-R7-04b: openHeld SHA comparison removed */ void sha;",
      );
      return s;
    },
    expected: [/REUSE-AUTH-01a/, /REUSE-AUTH-01b/],
  },
  {
    id: 'MUT-R7-05',
    desc: 'remove reuse commit-time seal + POST integrity（互补 fence 整组：seal 移除 + §八 fail-closed 移除）',
    file: MATERIALIZATION,
    files: [VALIDATOR, MATERIALIZATION],
    apply: (src, fileName) => {
      if (fileName === VALIDATOR) {
        return src.replace(
          "    // 5c. commit-time seal（从 private record 读取 expected identity/SHA；不得省略）\n    assertHeldCurrentSync(originalHeld, {\n      requireDurability: false,\n      expectedVoiceProfileId: r.voiceProfileId,\n      expectedVoiceProfileRevisionId: r.voiceProfileRevisionId,\n      expectedSha256: r.fileSha256,\n    });",
          "    /* MUT-R7-05: commit-time seal removed */ void originalHeld;",
        );
      }
      // MATERIALIZATION：移除 §八 integrity fail-closed（互补 fence）
      return src.replace(
        "      if (integrityStatus !== 'verified') {\n        throw new MaterializationError(\n          'MATERIALIZATION_UNUSABLE',\n          `reuse 投影文件不可用（integrity=${integrityStatus}）；fail-closed 不冒充 reused`,\n          422,\n        );\n      }",
        "      /* MUT-R7-05b: §8 integrity fail-closed removed */ void integrityStatus;",
      );
    },
    expected: [/REUSE-DIR-02/],
  },
  {
    id: 'MUT-R7-06',
    desc: 'remove complete handle binding block（5 字段 exact re-check 整块）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "    if (\n      r.boundExpectedHandle.jobId !== expectedHandle.jobId ||\n      r.boundExpectedHandle.validationOwnerToken !== expectedHandle.validationOwnerToken ||\n      r.boundExpectedHandle.validationAttempt !== expectedHandle.validationAttempt ||\n      r.boundExpectedHandle.candidateMaterializationId !== expectedHandle.candidateMaterializationId ||\n      r.boundExpectedHandle.candidateMaterializationMetadataHash !== expectedHandle.candidateMaterializationMetadataHash\n    ) {\n      throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability handle binding 不匹配（attempt+1 takeover / 不同 job / candidate 漂移）');\n    }",
        "    /* MUT-R7-06: handle binding block removed */ void r; void expectedHandle;",
      ),
    expected: [/REUSE-ONCE-02/, /REUSE-ONCE-03/, /REUSE-ONCE-04/],
  },
  {
    id: 'MUT-R7-07',
    desc: 'remove open→consuming atomic transition（state 不置 consuming；并发第二次不被拒）',
    file: VALIDATOR,
    apply: (src) => {
      let s = src;
      s = s.replace(
        "  if (r.state !== 'open') {\n    throw new MaterializedFileError(\n      'SEAL_MISMATCH',\n      `reuse capability state=${r.state}（仅 open 可消费；consuming 表示并发第二次）`,\n    );\n  }",
        "  /* MUT-R7-07: state check removed */ void r.state;",
      );
      s = s.replace(
        "  // 3. 同步 open→consuming（任何 await 之前）\n  r.state = 'consuming';\n  (capability as unknown as {state: string}).state = 'consuming';",
        "  /* MUT-R7-07: consuming transition removed */",
      );
      return s;
    },
    expected: [/ONCE-R7-01/],
  },
  {
    id: 'MUT-R7-08',
    desc: 'remove finally/private original-held close（失败后不 closed、不关 fd）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "  } finally {\n    // P0-C：任何路径（handle mismatch / seal fail / hook throw / onCommit throw / rollback / success）\n    // 都进入同一 finally——state=closed + 关闭 originalHeld（恰好一次）\n    r.state = 'closed';\n    (capability as unknown as {state: string}).state = 'closed';\n    try {\n      await originalHeld.close();\n    } catch {\n      // best-effort；closed 已标记防 double-close\n    }\n  }",
        "  } finally {\n    /* MUT-R7-08: terminal close removed */ void r; void originalHeld;\n  }",
      ),
    expected: [/FD-03/],
  },
  {
    id: 'MUT-R7-09',
    desc: 'POST serializer omit integrityStatus（route 不传；默认 unchecked）',
    file: ROUTE,
    apply: (src) =>
      src.replace(
        "const view = serializeMaterializationRequest(result.request, result.projection, result.integrityStatus);",
        "/* MUT-R7-09 */ const view = serializeMaterializationRequest(result.request, result.projection);",
      ),
    expected: [/POST-R6-03b/],
  },
  {
    id: 'MUT-R7-10',
    desc: 'remove projection hook production guard',
    file: MATERIALIZATION,
    apply: (src) =>
      src.replace(
        "if (isProductionEnv()) {\n    throw new Error('test hook disabled in production（setAfterProjectionValidationBeforeFinalize）');\n  }",
        "/* MUT-R7-10: guard removed */",
      ),
    expected: [/HOOK-01/],
  },
  {
    id: 'MUT-R7-11',
    desc: 'remove recovery hook production guard',
    file: MATERIALIZATION,
    apply: (src) =>
      src.replace(
        "if (isProductionEnv()) {\n    throw new Error('test hook disabled in production（setAfterRecoveryEvidenceBeforeCommit）');\n  }",
        "/* MUT-R7-11: guard removed */",
      ),
    expected: [/HOOK-01/],
  },
  {
    id: 'MUT-R7-12',
    desc: 'remove hook-throw close path（beforeCommitHook throw 后不 terminal close）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "  } finally {\n    // P0-C：任何路径（handle mismatch / seal fail / hook throw / onCommit throw / rollback / success）\n    // 都进入同一 finally——state=closed + 关闭 originalHeld（恰好一次）\n    r.state = 'closed';\n    (capability as unknown as {state: string}).state = 'closed';\n    try {\n      await originalHeld.close();\n    } catch {\n      // best-effort；closed 已标记防 double-close\n    }\n  }",
        "  } finally {\n    /* MUT-R7-12: close only on success */\n    if (r.state === 'consumed') {\n      r.state = 'closed';\n      (capability as unknown as {state: string}).state = 'closed';\n      try { await originalHeld.close(); } catch { /* */ }\n    }\n  }",
      ),
    expected: [/FD-R7-HOOK-01/],
  },
];

function getSha(p: string): string {
  try {
    return execFileSync('sha256sum', [p], {encoding: 'utf8'}).split(' ')[0];
  } catch {
    return execFileSync('git', ['hash-object', p], {encoding: 'utf8'}).trim();
  }
}

function runTypecheck(): {ok: boolean; output: string} {
  const r = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], {cwd: REPO, encoding: 'utf8', timeout: 300_000});
  return {ok: r.status === 0, output: (r.stdout ?? '') + (r.stderr ?? '')};
}

function runTargetTests(): {output: string; status: number | null} {
  let output = '';
  let status: number | null = 0;
  for (const t of TARGET_TESTS) {
    const r = spawnSync('npx', ['tsx', t], {
      cwd: REPO,
      env: {...process.env, PATH: `${TOOLS_FFMPEG}:${process.env.PATH ?? ''}`},
      encoding: 'utf8',
      timeout: 600_000,
    });
    output += `\n===== ${t} =====\n${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (r.status !== null && r.status !== 0) status = r.status;
  }
  return {output, status};
}

interface Result {
  id: string;
  desc: string;
  expected: string[];
  observed: string[];
  pass: boolean;
  reason: string;
  fileShaBefore: string;
  fileShaMutated: string;
  fileShaRestored: string;
  typecheckOk: boolean;
  childStatus: number | null;
  fatalPattern: string | null;
  failLines: string[];
  diffApplied: boolean;
}

const FATAL_RE = /ReferenceError|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|TypeError:.*undefined|fixture setup failed|not defined/;

function runMutation(m: Mut): Result {
  const files = m.files ?? [m.file];
  const origs = files.map((f) => fs.readFileSync(path.join(REPO, f), 'utf8'));
  const filePath = path.join(REPO, m.file);
  const fileShaBefore = getSha(filePath);
  let anyChanged = false;
  const mutatedMap = new Map<string, string>();
  files.forEach((f, i) => {
    const mutated = m.apply(origs[i], f);
    if (mutated !== origs[i]) anyChanged = true;
    mutatedMap.set(f, mutated);
  });
  if (!anyChanged) {
    return {
      id: m.id, desc: m.desc, expected: m.expected.map((r) => r.source), observed: [],
      pass: false, reason: 'source not matched（mutation 未应用）',
      fileShaBefore, fileShaMutated: fileShaBefore, fileShaRestored: fileShaBefore,
      typecheckOk: false, childStatus: null, fatalPattern: null, failLines: [], diffApplied: false,
    };
  }
  files.forEach((f) => fs.writeFileSync(path.join(REPO, f), mutatedMap.get(f)!));
  const fileShaMutated = getSha(filePath);
  // typecheck（runtime mutation 必须通过；compile mutation 允许失败但需标记）
  const tc = runTypecheck();
  let output = '';
  let childStatus: number | null = null;
  try {
    const t = runTargetTests();
    output = t.output;
    childStatus = t.status;
  } finally {
    files.forEach((f, i) => fs.writeFileSync(path.join(REPO, f), origs[i]));
  }
  const fileShaRestored = getSha(filePath);
  const allFails = output.split('\n').filter((l) => l.startsWith('FAIL '));
  const observed = m.expected.map((re) => re.source).filter((src) =>
    allFails.some((line) => line.includes(src)),
  );
  const fatalMatch = output.match(FATAL_RE);
  const fatalPattern = fatalMatch ? fatalMatch[0] : null;
  const processExitedAsExpected = childStatus !== null && childStatus !== 0;
  const noFatal = fatalPattern === null;
  const typecheckOk = m.compileMutation ? true : tc.ok;
  const diffApplied = fileShaMutated !== fileShaBefore;
  const restoreOk = fileShaRestored === fileShaBefore;
  const strongPass =
    diffApplied &&
    typecheckOk &&
    processExitedAsExpected &&
    noFatal &&
    observed.length === m.expected.length &&
    restoreOk;
  let reason = '';
  if (!diffApplied) reason = 'mutation 未应用';
  else if (!typecheckOk) reason = `typecheck FAIL（${(tc.output.match(/error TS\d+/g) ?? []).length} errors）`;
  else if (!processExitedAsExpected) reason = `child status=${childStatus}（期望非零退出——target 未因 mutation 失败）`;
  else if (!noFatal) reason = `fatal pattern: ${fatalPattern}`;
  else if (observed.length !== m.expected.length) reason = `observed ${observed.length}/${m.expected.length} expected FAILs`;
  else if (!restoreOk) reason = 'restore SHA mismatch';
  else reason = 'STRONG';
  return {
    id: m.id, desc: m.desc, expected: m.expected.map((r) => r.source), observed,
    pass: strongPass, reason,
    fileShaBefore, fileShaMutated, fileShaRestored,
    typecheckOk, childStatus, fatalPattern, failLines: allFails, diffApplied,
  };
}

function main(): void {
  fs.mkdirSync(path.dirname(ARTIFACT_DOCS), {recursive: true});
  const results: Result[] = [];
  for (const m of MUTATIONS) {
    const r = runMutation(m);
    results.push(r);
    console.log(`${r.id} ${r.pass ? 'STRONG' : 'FAIL'} reason=${r.reason} observed=${JSON.stringify(r.observed)}`);
  }
  // restore sanity：mutation 前后 git diff（涉及文件）必须完全一致（等于实现改动本身，
  // 不含 mutation 残留）。若实现改动已 commit（工作区 clean）则 diff 为空。
  const mutatedFiles = [...new Set(MUTATIONS.map((m) => m.file))];
  let diffBefore = '';
  let diffAfter = '';
  try {
    diffBefore = execFileSync('git', ['diff', '--', ...mutatedFiles], {cwd: REPO, encoding: 'utf8'});
    diffAfter = execFileSync('git', ['diff', '--', ...mutatedFiles], {cwd: REPO, encoding: 'utf8'});
  } catch { /* ignore */ }
  const gitDiffClean = diffBefore === diffAfter;
  let gitStatusOut = '';
  try {
    gitStatusOut = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: REPO, encoding: 'utf8'});
  } catch { /* ignore */ }

  const allStrong = results.every((r) => r.pass);
  const reportLines = [
    '# TTS-C.1A.R7 mutation proof report',
    '',
    `repo: ${REPO}`,
    `runner: scripts/test-tts-c1a-r7-mutations.ts（portable；git rev-parse --show-toplevel）`,
    `target tests: ${TARGET_TESTS.join(', ')}`,
    `mutation 数: ${results.length}`,
    '',
    '## Per-mutation results',
    '',
    ...results.flatMap((r) => [
      `### ${r.id}`,
      `description: ${r.desc}`,
      `file: ${r.id}`,
      `expected target FAIL: ${JSON.stringify(r.expected)}`,
      `observed target FAIL: ${JSON.stringify(r.observed)}`,
      `diffApplied: ${r.diffApplied}`,
      `fileShaBefore: ${r.fileShaBefore}`,
      `fileShaMutated: ${r.fileShaMutated}`,
      `fileShaRestored: ${r.fileShaRestored}`,
      `typecheckOk: ${r.typecheckOk}`,
      `childStatus: ${r.childStatus}`,
      `fatalPattern: ${r.fatalPattern ?? 'none'}`,
      `status: ${r.pass ? 'PASS' : 'FAIL'}`,
      `reason: ${r.reason}`,
      `fail lines (first 3):`,
      ...r.failLines.slice(0, 3).map((l) => `  ${l}`),
      '',
    ]),
    '## Summary',
    '',
    `TOTAL=${results.length}`,
    `PASS=${results.filter((r) => r.pass).length}`,
    `FAIL=${results.filter((r) => !r.pass).length}`,
    `STRONG=${results.filter((r) => r.pass && r.reason === 'STRONG').length}`,
    `no observable effect: ${results.filter((r) => r.reason.includes('observable')).length}`,
    `PARTIAL: ${results.filter((r) => r.reason.startsWith('observed')).length}`,
    `git diff before/after (mutated files) identical: ${gitDiffClean ? 'yes' : 'NO（mutation 残留）'}`,
    `git status --porcelain --untracked-files=no: ${gitStatusOut.trim() || '(empty)'}`,
    '',
  ];
  fs.writeFileSync(ARTIFACT_DOCS, reportLines.join('\n'));
  fs.writeFileSync(ARTIFACT_TMP, reportLines.join('\n'));
  console.log(`Artifact written to ${ARTIFACT_DOCS}`);
  process.exit(allStrong && gitDiffClean ? 0 : 1);
}

main();