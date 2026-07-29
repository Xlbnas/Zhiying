/**
 * M6.3.10：历史 AI 图像生成费用回填（一次性运维脚本）。
 *
 * 依据（已在生产 DB 验证）：generate route 只在 provider 成功产出 candidate 后
 * 才持久化 asset 行，且每次成功调用恰好写 1 行（candidates[0]）——
 * 因此每个 source_type='generated' 的 asset 行 = 一次已证成功的可计费调用。
 * provider 失败的历史调用无任何记录 → 无法回填（如实报告 gap，不伪造）。
 *
 * 幂等：event id = image-backfill-${assetId} + INSERT OR IGNORE；可重复运行。
 *
 * 用法：
 *   npx tsx scripts/backfill-image-usage.ts            # dry-run（默认）
 *   npx tsx scripts/backfill-image-usage.ts --apply    # 实际写入
 *   ZHIYING_DATA_DIR=/app/data npx tsx scripts/backfill-image-usage.ts --apply
 */

import {getDb} from '../src/lib/db';
import {recordImageGenerationUsage} from '../src/lib/usage-events';

interface GeneratedAssetRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  license_note: string | null;
  attribution: string | null;
  requirement_json: string | null;
  created_at: string;
}

const APPLY = process.argv.includes('--apply');

/** license_note 形如 "AI 生成 · gemini-3.1-flash-image (待确认)" → 提取 model。 */
function modelFromRow(row: GeneratedAssetRow): string {
  const m = /AI 生成 · (\S+)/.exec(row.license_note ?? '');
  if (m?.[1]) return m[1];
  const a = /API易 \/ (\S+)/.exec(row.attribution ?? '');
  if (a?.[1]) return a[1];
  return 'gemini-3.1-flash-image'; // 历史唯一使用过的模型（M6.3.9 期默认）
}

function requirementIdFromRow(row: GeneratedAssetRow): string | null {
  if (!row.requirement_json) return null;
  try {
    const req = JSON.parse(row.requirement_json) as {requirementId?: string; id?: string};
    return req.requirementId ?? req.id ?? null;
  } catch {
    return null;
  }
}

function main(): void {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, project_id, scene_id, license_note, attribution, requirement_json, created_at
     FROM assets WHERE source_type = 'generated' ORDER BY created_at ASC`,
  ).all() as GeneratedAssetRow[];

  console.log(`发现 ${rows.length} 个 generated asset 行（= 已证成功的可计费调用）`);
  let backfilled = 0;
  let skipped = 0;
  const perProject = new Map<string, number>();

  for (const row of rows) {
    const model = modelFromRow(row);
    const requirementId = requirementIdFromRow(row);
    const input = {
      attemptId: `image-backfill-${row.id}`,
      projectId: row.project_id,
      sceneId: row.scene_id ?? 'unknown',
      requirementId: requirementId ?? 'unknown',
      provider: 'apiyi',
      model,
      // 历史行未记录 size；M6.3.9 期 env 默认 1K（标注 sizeAssumed 供审计）
      requestedSize: '1K',
      aspectRatio: '16:9',
      imageCount: 1,
      status: 'succeeded' as const,
      createdAt: row.created_at,
      backfilled: true,
      assetId: row.id,
    };
    if (!APPLY) {
      console.log(`  [dry-run] ${row.project_id.slice(0, 8)} ${row.scene_id} ${row.created_at} model=${model}`);
      backfilled++;
      perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1);
      continue;
    }
    const result = recordImageGenerationUsage(input);
    if (result.inserted) {
      backfilled++;
      perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1);
    } else {
      skipped++;
    }
  }

  console.log(
    `${APPLY ? '已回填' : 'dry-run 将回填'} ${backfilled} 条 image usage event` +
      (skipped > 0 ? `，跳过已存在 ${skipped} 条` : '') +
      `（单价按写入时价目表快照，costSource=configured_estimate）`,
  );
  for (const [projectId, count] of perProject) {
    console.log(`  project ${projectId}: ${count} 次生成`);
  }
  console.log('注意：provider 失败的历史调用无迹可查，不在此回填（historical gap，如实报告）。');
}

main();
