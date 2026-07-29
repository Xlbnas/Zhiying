/**
 * M6.3.8：legacy asset → exact requirement binding 迁移脚本。
 *
 * 用法：
 *   npx tsx scripts/migrate-m638-requirement-bindings.ts            # dry-run（只打印决策）
 *   npx tsx scripts/migrate-m638-requirement-bindings.ts --apply    # 实际写入
 *   npx tsx scripts/migrate-m638-requirement-bindings.ts --project=<id> [--apply]
 *
 * 规则（正确性优先，允许 READY 数下降；绝不 sequential guess）：
 *   - requirement_json 与需求语义精确一致 → bind_exact
 *   - 场景仅 1 个需求 → bind_single
 *   - 其余 → ambiguous_unbound（保持 pending）
 * 幂等：已有 binding 的 asset 自动跳过。
 */

import {closeDb, getDb} from '../src/lib/db';
import {
  applyBindingMigration,
  planBindingMigration,
  type MigrationDecision,
} from '../src/lib/assets/migrate-bindings';
import {listAssetsForProject, listBindingsForProject} from '../src/lib/assets/model';
import {loadLatestScenesPlans} from '../src/lib/assets/requirements';

const APPLY = process.argv.includes('--apply');
const projectArg = process.argv.find((a) => a.startsWith('--project='));
const ONLY_PROJECT = projectArg ? projectArg.slice('--project='.length) : null;

function main(): void {
  const db = getDb();
  const projects = db
    .prepare('SELECT id, title FROM projects ORDER BY created_at ASC')
    .all() as Array<{id: string; title: string}>;

  let totalApplied = 0;
  const tally: Record<string, number> = {};

  for (const project of projects) {
    if (ONLY_PROJECT && project.id !== ONLY_PROJECT) continue;
    const assets = listAssetsForProject(project.id);
    if (assets.length === 0) {
      console.log(`\n== ${project.title} (${project.id}) — 无 assets，跳过`);
      continue;
    }
    const plans = loadLatestScenesPlans(project.id);
    if (!plans) {
      console.log(`\n== ${project.title} (${project.id}) — 无 scenes artifact，跳过（${assets.length} assets 未迁移）`);
      continue;
    }
    const bindings = listBindingsForProject(project.id);
    const decisions = planBindingMigration(project.id, plans, assets, bindings);

    console.log(`\n== ${project.title} (${project.id})`);
    console.log(`   assets=${assets.length} 已有 bindings=${bindings.length}`);
    for (const d of decisions) {
      tally[d.action] = (tally[d.action] ?? 0) + 1;
      const marker = d.action.startsWith('bind') ? '→' : '·';
      console.log(
        `   ${marker} [${d.action}] asset=${d.assetId.slice(0, 8)}… scene=${d.sceneId ?? '-'} req=${d.requirementId ?? '-'}  ${d.reason}`,
      );
    }
    if (APPLY) {
      const applied = applyBindingMigration(project.id, decisions);
      totalApplied += applied;
      console.log(`   applied=${applied}`);
    }
  }

  console.log(`\n===== 决策汇总 =====`);
  for (const [action, count] of Object.entries(tally)) {
    console.log(`  ${action}: ${count}`);
  }
  console.log(APPLY ? `已写入 ${totalApplied} 个 binding` : 'DRY-RUN（未写入；加 --apply 执行）');
  closeDb();
}

main();
