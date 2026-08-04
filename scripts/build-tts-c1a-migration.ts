#!/usr/bin/env tsx
/**
 * TTS-C.1A migration 生成器（唯一来源 = frozen 设计文档 §2，禁止手工复制漂移）。
 *
 * 提取 §2 的六个块（voice_materialization_requests / voice_materialization_jobs /
 * voice_materializations / legacy_adapter_voice_entries / voice_registry_publications /
 * voice_registry_publication_activations）的 executable SQL：
 *   pass 1 = 全部 CREATE TABLE（按 §2 顺序；SQLite 前向 FK 引用合法）；
 *   pass 2 = CREATE UNIQUE INDEX + CREATE TRIGGER（稳定排序保持同表 trigger 相对创建序）。
 * 包装为幂等形式（IF NOT EXISTS），并记录：
 *   frozenFragmentsSha256 = frozen 原文（注释保留）拼接 hash；
 *   appliedSqlSha256      = 幂等包装后 SQL hash。
 *
 * 用法：npx tsx scripts/build-tts-c1a-migration.ts [--out src/lib/tts-c/migration.generated.ts]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DOC = path.resolve(__dirname, '..', 'docs', 'TTS_C_INCREMENTAL_NARRATION_DESIGN.md');

const TARGET_SECTIONS = [
  'voice_materialization_requests',
  'voice_materialization_jobs',
  'voice_materializations',
  'legacy_adapter_voice_entries',
  'voice_registry_publications',
  'voice_registry_publication_activations',
];

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
    // 单行 trigger：BEGIN ... END; 一行内完成
    if (!inTrigger && begins && /END;?\s*$/.test(trimmed) && trimmed.includes('END')) {
      cur += line + '\n';
      out.push(cur);
      cur = '';
      continue;
    }
    if (!inTrigger && begins) inTrigger = true;
    cur += line + '\n';
    if (inTrigger && ends) {
      // trigger 结束：立即 flush（END; 是 trigger 语句的终止）
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
  // SQLite 3.45 不支持 CREATE TRIGGER IF NOT EXISTS（仅 TABLE/INDEX/VIEW）——
  // trigger 幂等采用 DROP TRIGGER IF EXISTS + 原 CREATE（重定义结果一致）。
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

export function buildMigrationSql(docPath: string): {
  frozenFragmentsSha256: string;
  appliedSqlSha256: string;
  appliedSql: string;
  tableNames: string[];
  triggerNames: string[];
  indexNames: string[];
} {
  const blocks = extractSection2Blocks(docPath);
  const allStatements: Array<{kind: 'table' | 'index' | 'trigger'; sql: string; order: number}> = [];
  for (const key of TARGET_SECTIONS) {
    const sql = blocks.get(key);
    if (sql === undefined) throw new Error(`§2 块缺失: ${key}`);
    for (const stmt of splitStatements(sql)) {
      // 剥离前导注释行（frozen 文档在 CREATE 前有说明注释；hash 绑定以纯 SQL 为准）
      const body = stmt.trim().replace(/^(?:--[^\n]*\n)+/, '').trim();
      if (body === '') continue;
      if (body.startsWith('CREATE TABLE ')) allStatements.push({kind: 'table', sql: body, order: allStatements.length});
      else if (body.startsWith('CREATE UNIQUE INDEX ') || body.startsWith('CREATE INDEX ')) {
        allStatements.push({kind: 'index', sql: body, order: allStatements.length});
      } else if (body.startsWith('CREATE TRIGGER ')) {
        allStatements.push({kind: 'trigger', sql: body, order: allStatements.length});
      } else {
        throw new Error(`无法识别的语句（块 ${key}）: ${body.slice(0, 60)}`);
      }
    }
  }
  const priority: Record<string, number> = {table: 0, index: 1, trigger: 2};
  allStatements.sort((a, b) => (priority[a.kind] - priority[b.kind]) || (a.order - b.order));
  const frozenFragments = allStatements.map((s) => s.sql.trim()).join('\n\n') + '\n';
  const appliedSql = allStatements.map((s) => wrapIdempotent(s.sql.trim())).join('\n\n') + '\n';
  const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  return {
    frozenFragmentsSha256: sha(frozenFragments),
    appliedSqlSha256: sha(appliedSql),
    appliedSql,
    tableNames: allStatements.filter((s) => s.kind === 'table').map((s) => /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
    triggerNames: allStatements.filter((s) => s.kind === 'trigger').map((s) => /CREATE TRIGGER ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
    indexNames: allStatements.filter((s) => s.kind === 'index').map((s) => /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/.exec(wrapIdempotent(s.sql))![1]),
  };
}

function main(): void {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? path.resolve(process.cwd(), process.argv[outIdx + 1]) : null;
  const built = buildMigrationSql(DOC);
  if (outPath) {
    const ts = `// GENERATED by scripts/build-tts-c1a-migration.ts — DO NOT EDIT BY HAND.
// 唯一来源 = docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md §2（frozen，SQL SHA c88f64ac…）。
// frozenFragmentsSha256 与 appliedSqlSha256 由 scripts/test-tts-c1a-migration.ts 复算绑定。
export const TTS_C1A_FROZEN_FRAGMENTS_SHA256 = '${built.frozenFragmentsSha256}';
export const TTS_C1A_APPLIED_SQL_SHA256 = '${built.appliedSqlSha256}';
export const TTS_C1A_TABLES = ${JSON.stringify(built.tableNames, null, 2)};
export const TTS_C1A_TRIGGERS = ${JSON.stringify(built.triggerNames, null, 2)};
export const TTS_C1A_INDEXES = ${JSON.stringify(built.indexNames, null, 2)};
export const TTS_C1A_MIGRATION_SQL = ${JSON.stringify(built.appliedSql)};
`;
    fs.writeFileSync(outPath, ts, 'utf8');
    console.log(`written ${outPath}`);
  }
  console.log(`frozenFragmentsSha256=${built.frozenFragmentsSha256}`);
  console.log(`appliedSqlSha256=${built.appliedSqlSha256}`);
  console.log(`tables=${built.tableNames.length} triggers=${built.triggerNames.length} indexes=${built.indexNames.length}`);
}

if (require.main === module) main();
