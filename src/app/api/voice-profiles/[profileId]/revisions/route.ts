/**
 * GET  /api/voice-profiles/[profileId]/revisions — revision 列表（revision_number 升序）
 * POST /api/voice-profiles/[profileId]/revisions — multipart 摄取（设计文档 §4；TTS-A.R1 streaming）
 *      字段：requestId（必填）、audio（必填 File）、transcript/language（可选）
 *
 * TTS-A.R1：上传主路径为 bounded multipart streaming（@fastify/busboy，见
 * src/lib/voice-library/multipart.ts），上传 body 由 parser 流式消费，不整读入内存；
 * audio 流式写入安全 staging 并计算 SHA256/实测字节数，再进入与 Buffer wrapper 相同的
 * 核心摄取函数（单一语义）。幂等：同 requestId + 同 fingerprint → exact 校验 usable 才
 * 200 reused；损坏 → 409 revision_unusable；异内容 → 409；同 Profile 相同 canonical hash
 * → 409 duplicate_audio。
 */
import fs from 'node:fs';
import {getVoiceProfile} from '@/lib/voice-library/profiles';
import {
  ingestVoiceProfileRevisionFromStaged,
  listVoiceProfileRevisions,
} from '@/lib/voice-library/revisions';
import {parseVoiceUploadMultipart} from '@/lib/voice-library/multipart';
import {serializeRevision} from '@/lib/voice-library/types';
import {jsonError} from '../../../_lib/shared';
import {voiceLibraryErrorResponse} from '../../_lib';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  const profile = getVoiceProfile(profileId);
  if (!profile) return jsonError(404, 'profile_not_found');
  const rows = listVoiceProfileRevisions(profileId);
  return Response.json({revisions: rows.map(serializeRevision)});
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  const profile = getVoiceProfile(profileId);
  if (!profile) return jsonError(404, 'profile_not_found');

  let stagingDir: string | null = null;
  try {
    // streaming multipart：Content-Length 预检 + 流式实测字节 + 单文件/字段严格性；
    // audio 流式写入安全 staging（完整音频不进 Buffer），返回 staged input + SHA256 + 字节数
    const staged = await parseVoiceUploadMultipart(req);
    stagingDir = staged.stagingDir;

    const result = await ingestVoiceProfileRevisionFromStaged({
      voiceProfileId: profileId,
      requestId: staged.requestId as string,
      stagingDir: staged.stagingDir,
      stagedOriginalPath: staged.originalPath,
      originalSha256: staged.originalSha256,
      byteLength: staged.byteLength,
      originalFilename: staged.originalFilename,
      transcript: staged.transcript,
      language: staged.language,
    });
    return Response.json(
      {outcome: result.outcome, revision: serializeRevision(result.revision)},
      {status: result.status},
    );
  } catch (err) {
    return voiceLibraryErrorResponse(err);
  } finally {
    // staging 安全清理（幂等；绝不触碰 final 文件）
    if (stagingDir !== null) {
      fs.rmSync(stagingDir, {recursive: true, force: true});
    }
  }
}
