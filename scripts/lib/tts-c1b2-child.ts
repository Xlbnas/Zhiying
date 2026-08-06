/**
 * TTS-C.1B.2 并发测试 child（真实独立进程 + 独立 SQLite 连接）。
 * 用法：
 *   tsx scripts/lib/tts-c1b2-child.ts <dataDir> import <registryFilePath> <voiceRootDir>
 *   tsx scripts/lib/tts-c1b2-child.ts <dataDir> claim <subjectType> <subjectId> <subjectMode> <stableSha>
 * 输出：单行 JSON {ok, ...}。
 */
import process from 'node:process';
import path from 'node:path';
import {closeDb, getDb} from '../../src/lib/db';
import {importLegacyRegistry} from '../../src/lib/tts-c/legacy-import';
import {claimPublication, publishRegistryCandidate} from '../../src/lib/tts-c/registry-publisher';
import {takeoverExpiredPublication} from '../../src/lib/tts-c/registry-activation';

async function main(): Promise<void> {
  const [, , dataDir, op, ...rest] = process.argv;
  process.env.ZHIYING_DATA_DIR = dataDir;
  const db = getDb();
  try {
    if (op === 'import') {
      const [registryFilePath, voiceRootDir, emitRoot] = rest;
      const result = await importLegacyRegistry(db, {
        registryFilePath,
        voiceRootDir,
        resolveReferencePath: emitRoot ? (p) => path.join(voiceRootDir, p.replace(new RegExp('^' + emitRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), '')) : undefined,
      });
      process.stdout.write(JSON.stringify({ok: true, inserted: result.inserted, reused: result.reused, keys: result.keys}));
    } else if (op === 'publish') {
      const [subjectType, subjectId, subjectMode, stableSha, voiceRootDir, matRootDir, emitRoot] = rest;
      const result = await publishRegistryCandidate(db, {
        subject: {subjectType: subjectType as never, subjectId, subjectMode: subjectMode as never},
        stableRegistrySha256: stableSha,
        build: {
          legacyVoiceRootDir: voiceRootDir,
          materializationRootDir: matRootDir,
          emitVoiceRootPath: emitRoot,
          resolveLegacyReferencePath: (p) => path.join(voiceRootDir, p.replace(new RegExp('^' + emitRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), '')),
        },
      });
      process.stdout.write(
        JSON.stringify({
          ok: true,
          kind: result.kind,
          publicationId: result.publicationId,
          generation: result.generation,
          status: result.status,
          candidateRegistrySha256: 'candidateRegistrySha256' in result ? result.candidateRegistrySha256 : undefined,
          hasOwnerToken: false,
        }),
      );
    } else if (op === 'takeover') {
      const [publicationId] = rest;
      const result = takeoverExpiredPublication(db, publicationId);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          kind: result.kind,
          ...(result.kind === 'taken' ? {handle: result.handle} : {reason: result.reason}),
        }),
      );
    } else if (op === 'claim') {
      const [subjectType, subjectId, subjectMode, stableSha] = rest;
      const result = claimPublication(db, {
        subject: {subjectType: subjectType as never, subjectId, subjectMode: subjectMode as never},
        stableRegistrySha256: stableSha,
      });
      process.stdout.write(
        JSON.stringify({
          ok: true,
          kind: result.kind,
          publicationId: result.publication.id,
          generation: result.publication.generation,
          status: result.publication.status,
        }),
      );
    } else {
      process.stdout.write(JSON.stringify({ok: false, message: `unknown op ${op}`}));
    }
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: err instanceof Error && 'code' in err ? (err as {code?: string}).code : undefined,
        message: err instanceof Error ? err.message.slice(0, 200) : String(err),
      }),
    );
  } finally {
    closeDb();
  }
}

void main();
