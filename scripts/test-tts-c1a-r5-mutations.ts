/**
 * TTS-C.1A.R5 mutation proof runner（reproducible）。
 *
 * 依次对 runtime 实施 9 项 mutation（每项对应 §十一 MUT-R5-01..09），每次变异仅修改
 * 真实生效点；运行 test-tts-c1a-r5-hardening.ts，断言「目标测试」FAIL；最后 cp 恢复。
 * 输出汇总（mutation + 目标测试 + 实测 FAIL 行 + artifact path）写到
 *   /tmp/r5-mutation-output.txt
 * 供独立 Review 复核（spec §十一 要求 reproducible runner）。
 *
 * 用法：npx tsx scripts/test-tts-c1a-r5-mutations.ts
 * 退出码：0=全部目标 FAIL 符合预期；1=任一目标未 FAIL（mutation 不充分或 R5 测试有 bug）。
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/home/agentvm/projects/ZhiYing';
const BACKUP = '/tmp/r5-mut-backup';
const ARTIFACT = '/tmp/r5-mutation-output.txt';
const TARGET_TEST = 'scripts/test-tts-c1a-r5-hardening.ts';
const TOOLS_FFMPEG = `${REPO}/.tools/static-ffmpeg`;

interface Mut {
  id: string;
  desc: string;
  file: string;          // relative to REPO
  // mutator: takes file content, returns mutated content
  apply: (src: string) => string;
  // expected failures (regex matches against PASS/FAIL lines)
  expected: RegExp[];
}

const VALIDATOR = 'src/lib/tts-c/materialized-file-validator.ts';
const MATERIALIZATION = 'src/lib/tts-c/materialization.ts';

const MUTATIONS: Mut[] = [
  {
    id: 'MUT-R5-01',
    desc: 'WeakMap mode check 移除（assertHeldCurrentSync 不再校验 requireDurability）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "if (opts.requireDurability && r.mode !== 'durabilize') {\n    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 非 durabilize mode（不得成功终局）');\n  }",
        "/* MUT-R5-01 */ if (false && opts.requireDurability && r.mode !== 'durabilize') { throw new MaterializedFileError('SEAL_MISMATCH', '...'); }",
      ),
    expected: [/CAP-06/],
  },
  {
    id: 'MUT-R5-02',
    desc: 'seal 改回读取 public evidence（用 held.evidence 替代 record）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "if (opts.expectedSha256 !== undefined && snap.sha256 !== opts.expectedSha256) {",
        "if (opts.expectedSha256 !== undefined && (heldObject as unknown as {evidence: {sha256: string}}).evidence.sha256 !== opts.expectedSha256) { /* MUT-R5-02 */",
      ),
    expected: [/CAP-07/],
  },
  {
    id: 'MUT-R5-03',
    desc: 'reuse capability brand 移除（issueValidatedReusableCapability 不注册 WeakMap）',
    file: VALIDATOR,
    apply: (src) =>
      src.replace(
        "    reuseRecords.set(this, {...fields, closed: false});",
        "    /* MUT-R5-03 */ void this;",
      ),
    expected: [/REUSE-CAP-01/],
  },
  {
    id: 'MUT-R5-04',
    desc: 'reuse SHA authority 改回 caller field（finalizeValidatingJob 不比对 record vs projection SHA）',
    file: MATERIALIZATION,
    apply: (src) => {
      // 移除 finalizeValidatingJob 中 cap.fileSha256 !== projection.source_canonical_sha256 的 fail-closed
      const old = "      if (cap.fileSha256 !== currentProjection.source_canonical_sha256) {\n        throw new MaterializationError('MATERIALIZATION_UNUSABLE', 'capability.fileSha256 ≠ projection row SHA', 409);\n      }";
      const repl = "      /* MUT-R5-04 */ void cap.fileSha256; // §D SHA authority closure removed";
      return src.includes(old) ? src.replace(old, repl) : src;
    },
    expected: [/REUSE-CAP-03/],
  },
  {
    id: 'MUT-R5-05',
    desc: 'reuse profile ancestor seal 移除 + parent realpath 等值（profile swap 互补整组）',
    file: VALIDATOR,
    apply: (src) => {
      // 删除 profile ancestor seal 整块
      const idx1 = src.indexOf('  // profile\n  let profileStat:');
      if (idx1 === -1) throw new Error('profile seal block not found');
      const end1 = src.indexOf('  // revision (final parent)', idx1);
      let s = src.slice(0, idx1) + '  /* MUT-R5-05: profile seal removed */ ' + src.slice(end1);
      // 进一步删除 parent realpath 等值检查
      const idx2 = s.indexOf("  if (realParentNow !== snap.parentRealpath) fail('SEAL_MISMATCH', 'parentRealpath drift vs acquired');");
      if (idx2 !== -1) {
        s = s.slice(0, idx2) + "  /* MUT-R5-05: parent realpath equality removed */" + s.slice(idx2 + "  if (realParentNow !== snap.parentRealpath) fail('SEAL_MISMATCH', 'parentRealpath drift vs acquired');".length);
      }
      return s;
    },
    expected: [/REUSE-DIR-01/, /REUSE-DIR-03/],
  },
  {
    id: 'MUT-R5-06',
    desc: 'reuse root seal 移除 + parent realpath 等值（root swap 互补整组）',
    file: VALIDATOR,
    apply: (src) => {
      // 删除 root 整块
      const idx1 = src.indexOf('  // root\n  let rootStat:');
      if (idx1 === -1) throw new Error('root seal block not found');
      const end1 = src.indexOf('  // profile\n', idx1);
      let s = src.slice(0, idx1) + '  /* MUT-R5-06: root seal removed */ ' + src.slice(end1);
      // 删除 parent realpath 等值（与 profile ancestor seal 的互补 fence）
      const idx2 = s.indexOf("  if (realParentNow !== snap.parentRealpath) fail('SEAL_MISMATCH', 'parentRealpath drift vs acquired');");
      if (idx2 !== -1) {
        s = s.slice(0, idx2) + "  /* MUT-R5-06: parent realpath equality removed */" + s.slice(idx2 + "  if (realParentNow !== snap.parentRealpath) fail('SEAL_MISMATCH', 'parentRealpath drift vs acquired');".length);
      }
      return s;
    },
    expected: [/REUSE-DIR-02/],
  },
  {
    id: 'MUT-R5-07',
    desc: 'final response 改回 validation.kind projection（取消 RESP-01/04 link closure）',
    file: MATERIALIZATION,
    apply: (src) =>
      src.replace(
        "const finalProjection =\n      finalRequest.materialization_id !== null\n        ? (getMaterializationById(finalRequest.materialization_id) ?? null)\n        : null;",
        "/* MUT-R5-07 */ const finalProjection = {} as never; // 取消 §七 link closure（始终非 null，破坏 RESP-01/04）",
      ),
    expected: [/RESP-01/],
  },
  {
    id: 'MUT-R5-08',
    desc: 'POST 取消 §七 link closure + §八 integrity（同时移除 link closure 与 integrity throw）',
    file: MATERIALIZATION,
    apply: (src) => {
      let s = src;
      // §七：link closure 移除
      const r1 = "const finalProjection =\n      finalRequest.materialization_id !== null\n        ? (getMaterializationById(finalRequest.materialization_id) ?? null)\n        : null;";
      if (s.includes(r1)) {
        s = s.replace(r1, "/* MUT-R5-08 */ const finalProjection = {} as never; // 取消 §七 link closure");
      }
      // §八：integrity throw 移除
      const r2 = "      if (integrityStatus !== 'verified') {\n        throw new MaterializationError(\n          'MATERIALIZATION_UNUSABLE',\n          `reuse 投影文件不可用（integrity=${integrityStatus}）；fail-closed 不冒充 reused`,\n          422,\n        );\n      }";
      if (s.includes(r2)) {
        s = s.replace(r2, "      /* MUT-R5-08 */ void integrityStatus; // §8 fail-closed removed");
      }
      return s;
    },
    expected: [/RESP-01/, /POST-INT-02/],
  },
  {
    id: 'MUT-R5-09',
    desc: 'production hook guard 移除（setAfter* 不再 check NODE_ENV）',
    file: MATERIALIZATION,
    apply: (src) => {
      const reA = /if \(isProductionEnv\(\)\) \{\s+throw new Error\('test hook disabled in production（setAfterProjectionValidationBeforeFinalize）'\);\s+\}\s+afterProjectionValidationBeforeFinalize = fn;/;
      const reB = /if \(isProductionEnv\(\)\) \{\s+throw new Error\('test hook disabled in production（setAfterRecoveryEvidenceBeforeCommit）'\);\s+\}\s+afterRecoveryEvidenceBeforeCommit = fn;/;
      return src.replace(reA, '/* MUT-R5-09 */ afterProjectionValidationBeforeFinalize = fn;')
                 .replace(reB, '/* MUT-R5-09 */ afterRecoveryEvidenceBeforeCommit = fn;');
    },
    expected: [/HOOK-01/, /HOOK-02/],
  },
];

function ensureBackup(): void {
  fs.mkdirSync(BACKUP, {recursive: true});
  for (const m of MUTATIONS) {
    fs.copyFileSync(path.join(REPO, m.file), path.join(BACKUP, path.basename(m.file)));
  }
}

function restore(): void {
  for (const m of MUTATIONS) {
    fs.copyFileSync(path.join(BACKUP, path.basename(m.file)), path.join(REPO, m.file));
  }
}

function runTest(): string {
  const r = spawnSync('npx', ['tsx', TARGET_TEST], {
    cwd: REPO,
    env: {...process.env, PATH: `${TOOLS_FFMPEG}:${process.env.PATH ?? ''}`},
    encoding: 'utf8',
    timeout: 600_000,
  });
  return (r.stdout ?? '') + '\n' + (r.stderr ?? '');
}

interface Result {
  id: string;
  desc: string;
  expected: string[];
  observed: string[];
  pass: boolean;
  artifacts: string[];
}

function runMutation(m: Mut): Result {
  const filePath = path.join(REPO, m.file);
  const orig = fs.readFileSync(filePath, 'utf8');
  const mutated = m.apply(orig);
  fs.writeFileSync(filePath, mutated);
  let output: string;
  try {
    output = runTest();
  } finally {
    fs.writeFileSync(filePath, orig);
  }
  const allFails = output.split('\n').filter((l) => l.startsWith('FAIL '));
  const observed = m.expected.map((re) => re.source).filter((src) =>
    allFails.some((line) => line.includes(src)),
  );
  return {
    id: m.id,
    desc: m.desc,
    expected: m.expected.map((re) => re.source),
    observed,
    pass: observed.length === m.expected.length,
    artifacts: allFails,
  };
}

function main(): void {
  ensureBackup();
  const results: Result[] = [];
  try {
    for (const m of MUTATIONS) {
      const r = runMutation(m);
      results.push(r);
      console.log(`${r.id} ${r.pass ? 'PASS' : 'FAIL'} expected=${JSON.stringify(r.expected)} observed=${JSON.stringify(r.observed)}`);
    }
  } finally {
    restore();
  }
  // 恢复后再跑一次套件确认全绿
  const finalOutput = runTest();
  const finalFails = finalOutput.split('\n').filter((l) => l.startsWith('FAIL '));
  const finalSummary = finalOutput.split('\n').filter((l) => l.startsWith('TTS-C.1A.R5 hardening:')).pop() ?? '';

  const reportLines = [
    '# TTS-C.1A.R5 mutation proof report',
    '',
    `mutation source: scripts/test-tts-c1a-r5-mutations.ts`,
    `target test: scripts/test-tts-c1a-r5-hardening.ts`,
    `backup dir: ${BACKUP}`,
    '',
    '## Per-mutation results',
    '',
    ...results.map((r) => [
      `### ${r.id}`,
      `description: ${r.desc}`,
      `expected target FAIL: ${JSON.stringify(r.expected)}`,
      `observed target FAIL: ${JSON.stringify(r.observed)}`,
      `status: ${r.pass ? 'PASS' : 'FAIL'}`,
      '',
    ].join('\n')),
    '## Final restore sanity',
    '',
    `final test summary: ${finalSummary.trim()}`,
    `final FAIL count: ${finalFails.length}`,
    '',
  ];
  fs.writeFileSync(ARTIFACT, reportLines.join('\n'));
  console.log(`Artifact written to ${ARTIFACT}`);
  const allPass = results.every((r) => r.pass) && finalFails.length === 0;
  process.exit(allPass ? 0 : 1);
}

main();