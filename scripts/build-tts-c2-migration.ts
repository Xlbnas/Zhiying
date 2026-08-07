#!/usr/bin/env tsx
/**
 * TTS-C.2 migration 生成器（唯一来源 = frozen 设计文档 §2，禁止手工复制漂移）。
 *
 * 复用 TTS-C.1A 生成器（scripts/build-tts-c1a-migration.ts）的同一提取/切分/幂等机制，
 * TARGET_SECTIONS 覆盖 C.2 冻结块：
 *   tts_jobs（§2.0：ADD COLUMN + INDEX + TRIGGER；零 rebuild）
 *   tts_audio_requests（§2.1）/ tts_synthesis_claims（§2.2）/
 *   tts_claim_generation_dispatches（§2.2b）/ tts_job_execution_transitions（§2.2c）/
 *   tts_generation_attempts（§2.3）/ sentence_audio_artifacts（§2.4）
 *
 * 排序：table(0) → alter(1) → index(2) → trigger(3)（§2.0 依赖顺序说明：先建新表再
 * ALTER tts_jobs——SQLite 前向 FK 引用合法但按文档建议先 CREATE 后 ALTER）。
 * ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 幂等语法——单独输出 TTS_C2_TTS_JOBS_ALTERS，
 * 由 migration-c2.ts 按列存在性动态跳过（应用侧幂等）。
 *
 * 用法：npx tsx scripts/build-tts-c2-migration.ts [--out src/lib/tts-c/migration-c2.generated.ts]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── 与 scripts/build-tts-c1a-migration.ts 同源的 frozen §2 提取机制（纯函数复制，
//    避免 tsx CJS 模块加载差异；逻辑与 1A 生成器逐行一致，非第三套 schema 生成器） ──

/** 逐行扫描 SQL 语句：跟踪 trigger BEGIN/END 与注释，按行尾 ';' 切分。 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inTrigger = false;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine;
    const trimmed = line.trim();
    if (trimmed === '') {
      cur += line + '\n';
      continue;
    }
    const begins = /^BEGIN\b/i.test(trimmed);
    const ends = /^END;?\s*$/i.test(trimmed);
    if (!inTrigger && begins && /END;?\s*$/.test(trimmed) && trimmed.includes('END')) {
      cur += line + '\n';
      out.push(cur);
      cur = '';
      continue;
    }
    if (!inTrigger && begins) inTrigger = true;
    cur += line + '\n';
    if (inTrigger && ends) {
      out.push(cur);
      cur = '';
      inTrigger = false;
      continue;
    }
    if (!inTrigger && trimmed.endsWith(';')) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function extractSection2Blocks(docPath: string): Map<string, string> {
  const text = fs.readFileSync(docPath, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 2. '));
  const end = lines.findIndex((l) => l.startsWith('## 3. '));
  if (start < 0 || end < 0) throw new Error('§2 边界未找到');
  const blocks = new Map<string, string>();
  let curKey: string | null = null;
  let inCode = false;
  const cur: string[] = [];
  for (let i = start; i < end; i++) {
    const l = lines[i];
    const m = /^### 2\.\d+(?:\.\d+)?[a-z]? `([^`]+)`/.exec(l);
    if (m) {
      if (inCode) throw new Error(`未闭合代码块: ${curKey}`);
      if (curKey !== null) blocks.set(curKey, cur.join('\n'));
      curKey = m[1];
      cur.length = 0;
      continue;
    }
    if (curKey === null) continue;
    if (!inCode && l.trim().startsWith('```sql')) {
      inCode = true;
      continue;
    }
    if (inCode && l.trim().startsWith('```')) {
      inCode = false;
      continue;
    }
    if (inCode) cur.push(l);
  }
  if (inCode) throw new Error('未闭合代码块');
  if (curKey !== null) blocks.set(curKey, cur.join('\n'));
  return blocks;
}

function wrapIdempotent(stmt: string): string {
  const triggerName = /^CREATE TRIGGER (?:IF NOT EXISTS )?([a-z_]+)/.exec(stmt.trim());
  if (triggerName) {
    const body = stmt.trim().replace(/^CREATE TRIGGER (?:IF NOT EXISTS )?/, 'CREATE TRIGGER ');
    return `DROP TRIGGER IF EXISTS ${triggerName[1]};
${body}`;
  }
  return stmt
    .replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ');
}

const DOC = path.resolve(__dirname, '..', 'docs', 'TTS_C_INCREMENTAL_NARRATION_DESIGN.md');

const TARGET_SECTIONS = [
  'tts_jobs',
  'tts_audio_requests',
  'tts_synthesis_claims',
  'tts_claim_generation_dispatches',
  'tts_job_execution_transitions',
  'tts_generation_attempts',
  'sentence_audio_artifacts',
];

export function buildC2MigrationSql(docPath: string): {
  frozenFragmentsSha256: string;
  appliedSqlSha256: string;
  tablesSql: string;
  indexesSql: string;
  triggersSql: string;
  tableNames: string[];
  triggerNames: string[];
  indexNames: string[];
  ttsJobsAlters: string[];
} {
  const blocks = extractSection2Blocks(docPath);
  const allStatements: Array<{kind: 'table' | 'alter' | 'index' | 'trigger'; sql: string; order: number}> = [];
  for (const key of TARGET_SECTIONS) {
    const sql = blocks.get(key);
    if (sql === undefined) throw new Error(`§2 块缺失: ${key}`);
    for (const stmt of splitStatements(sql)) {
      const body = stmt.trim().replace(/^(?:--[^\n]*\n)+/, '').trim();
      if (body === '') continue;
      // 整条语句全部由注释行构成（如 §2.0 末尾的说明注释）→ 跳过；
      // trigger 体内部的注释行不会被影响（语句含其他 SQL 行）
      const lines = body.split('\n');
      if (lines.every((l) => l.trim() === '' || l.trim().startsWith('--'))) continue;
      if (body.startsWith('CREATE TABLE ')) allStatements.push({kind: 'table', sql: body, order: allStatements.length});
      else if (body.startsWith('ALTER TABLE ')) allStatements.push({kind: 'alter', sql: body, order: allStatements.length});
      else if (body.startsWith('CREATE UNIQUE INDEX ') || body.startsWith('CREATE INDEX ')) {
        allStatements.push({kind: 'index', sql: body, order: allStatements.length});
      } else if (body.startsWith('CREATE TRIGGER ')) {
        allStatements.push({kind: 'trigger', sql: body, order: allStatements.length});
      } else {
        throw new Error(`无法识别的语句（块 ${key}）: ${body.slice(0, 60)}`);
      }
    }
  }
  const priority: Record<string, number> = {table: 0, alter: 1, index: 2, trigger: 3};
  allStatements.sort((a, b) => (priority[a.kind] - priority[b.kind]) || (a.order - b.order));
  const frozenFragments = allStatements.map((s) => s.sql.trim()).join('\n\n') + '\n';
  // appliedSql 不含 ALTER（无幂等语法；由应用层按列存在性动态跳过）。
  // 分段输出：应用顺序 tables → alters → indexes → triggers（trigger/index 引用 tts_jobs
  // 新列，必须在 ALTER 之后创建）。
  const tablesSql = allStatements.filter((s) => s.kind === 'table').map((s) => wrapIdempotent(s.sql.trim())).join('\n\n') + '\n';
  const indexesSql = allStatements.filter((s) => s.kind === 'index').map((s) => wrapIdempotent(s.sql.trim())).join('\n\n') + '\n';
  const triggersSql = allStatements.filter((s) => s.kind === 'trigger').map((s) => wrapIdempotent(s.sql.trim())).join('\n\n') + '\n';
  const ttsJobsAlters = allStatements.filter((s) => s.kind === 'alter').map((s) => s.sql.trim());
  const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  return {
    frozenFragmentsSha256: sha(frozenFragments),
    appliedSqlSha256: sha(tablesSql + indexesSql + triggersSql),
    tablesSql,
    indexesSql,
    triggersSql,
    tableNames: allStatements.filter((s) => s.kind === 'table').map((s) => /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
    triggerNames: allStatements.filter((s) => s.kind === 'trigger').map((s) => /CREATE TRIGGER ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
    indexNames: allStatements.filter((s) => s.kind === 'index').map((s) => /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
    ttsJobsAlters,
  };
}

function main(): void {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? path.resolve(process.cwd(), process.argv[outIdx + 1]) : null;
  const built = buildC2MigrationSql(DOC);
  if (outPath) {
    const ts = `// GENERATED by scripts/build-tts-c2-migration.ts — DO NOT EDIT BY HAND.
// 唯一来源 = docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md §2（frozen C.2 块：
// tts_jobs §2.0 / tts_audio_requests §2.1 / tts_synthesis_claims §2.2 /
// tts_claim_generation_dispatches §2.2b / tts_job_execution_transitions §2.2c /
// tts_generation_attempts §2.3 / sentence_audio_artifacts §2.4）。
// frozenFragmentsSha256 与 appliedSqlSha256 由测试复算绑定。
// 应用顺序：TTS_C2_TABLES_SQL → TTS_C2_TTS_JOBS_ALTERS（按列存在性动态跳过）→
// TTS_C2_INDEXES_SQL → TTS_C2_TRIGGERS_SQL。
export const TTS_C2_FROZEN_FRAGMENTS_SHA256 = '${built.frozenFragmentsSha256}';
export const TTS_C2_APPLIED_SQL_SHA256 = '${built.appliedSqlSha256}';
export const TTS_C2_TABLES = ${JSON.stringify(built.tableNames, null, 2)};
export const TTS_C2_TRIGGERS = ${JSON.stringify(built.triggerNames, null, 2)};
export const TTS_C2_INDEXES = ${JSON.stringify(built.indexNames, null, 2)};
export const TTS_C2_TTS_JOBS_ALTERS = ${JSON.stringify(built.ttsJobsAlters, null, 2)};
export const TTS_C2_TABLES_SQL = ${JSON.stringify(built.tablesSql)};
export const TTS_C2_INDEXES_SQL = ${JSON.stringify(built.indexesSql)};
export const TTS_C2_TRIGGERS_SQL = ${JSON.stringify(built.triggersSql)};
`;
    fs.writeFileSync(outPath, ts, 'utf8');
    console.log(`written ${outPath}`);
  }
  console.log(`frozenFragmentsSha256=${built.frozenFragmentsSha256}`);
  console.log(`appliedSqlSha256=${built.appliedSqlSha256}`);
  console.log(`tables=${built.tableNames.length} triggers=${built.triggerNames.length} indexes=${built.indexNames.length} alters=${built.ttsJobsAlters.length}`);
}

if (require.main === module) main();
