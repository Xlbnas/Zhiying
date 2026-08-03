/**
 * TTS-A.R1：bounded multipart streaming helper —— production POST /revisions 上传主路径。
 *
 * 用 @fastify/busboy 3.2.0（维护中的 busboy fork，固定版本，见 package.json）流式解析，
 * 上传 body 由 parser 流式消费，不整读入内存：
 *
 * - Content-Length 预检：存在且 > MAX_REFERENCE_MULTIPART_BODY_BYTES → 读取 body 前 413；
 * - 流式实测字节：chunked / 无 Content-Length / 伪造偏小 → 超限立即中止（不消费剩余 body）；
 * - audio 单文件流式写入安全 staging（O_CREAT|O_EXCL|O_NOFOLLOW，0600）并同步计算 SHA256；
 *   完整音频不进入 Buffer；
 * - 字段严格白名单 requestId/audio/transcript/language：未知字段、多 audio、重复文本字段、
 *   文件字段伪装成文本字段、文本字段伪装成文件、缺字段 → 422；畸形 multipart → 400；
 * - 文件大小（>25MB）→ 413 file_too_large；MIME/扩展名仅 display，真实性由摄取管线
 *   ffprobe 判定（本模块不基于 MIME/扩展名做真实性判断）。
 *
 * staging 目录由 route 在 finally 中清理；本模块失败路径同样不残留文件。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import Busboy from '@fastify/busboy';
import {getDataDir} from '@/lib/db';
import {
  MAX_MULTIPART_FIELDS,
  MAX_MULTIPART_FIELD_BYTES,
  MAX_REFERENCE_MULTIPART_BODY_BYTES,
  MAX_REFERENCE_UPLOAD_BYTES,
  STAGING_DIR_NAME,
  VOICE_LIBRARY_ROOT,
} from './constants';
import {ensureSafeDir, voiceLibraryRootAbs} from './revisions';
import {VoiceLibraryError} from './types';

/** multipart 解析成功后的 staged 上传结果（original 已安全写入并 fsync）。 */
export interface StagedVoiceUpload {
  stagingDir: string;
  originalPath: string;
  originalSha256: string;
  byteLength: number;
  originalFilename: string | null;
  requestId: string | null;
  transcript: string | null;
  language: string | null;
}

function bodyLimitMb(): string {
  return (MAX_REFERENCE_MULTIPART_BODY_BYTES / 1024 / 1024).toFixed(0);
}

function fileLimitMb(): string {
  return (MAX_REFERENCE_UPLOAD_BYTES / 1024 / 1024).toFixed(0);
}

/**
 * 解析 multipart 上传：
 * - 非 multipart content-type → 400 invalid_formdata；
 * - Content-Length 明确超限 → 读取 body 前 413 body_too_large；
 * - 流式累计实测字节超限 → 413 body_too_large（立即中止）；
 * - 单文件超 25MB → 413 file_too_large；
 * - 字段/数量/伪装/重复违规 → 422 invalid_request；
 * - parser 错误 / 客户端断连 → 400 invalid_formdata（不进入摄取管线）。
 * 失败时抛 VoiceLibraryError；staging 由调用方 finally 清理。
 */
export async function parseVoiceUploadMultipart(req: Request): Promise<StagedVoiceUpload> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new VoiceLibraryError('invalid_formdata', 400, '请求体不是合法 multipart/form-data');
  }
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const cl = Number(contentLengthHeader);
    if (Number.isFinite(cl) && cl > MAX_REFERENCE_MULTIPART_BODY_BYTES) {
      // 在读取 body 前返回 413
      throw new VoiceLibraryError(
        'body_too_large',
        413,
        `multipart 请求体超过 ${bodyLimitMb()}MB 上限（Content-Length 预检）`,
      );
    }
  }
  if (!req.body) {
    throw new VoiceLibraryError('invalid_formdata', 400, '请求体为空');
  }

  // 安全建立 staging：root → .staging → <uuid>（任一已存在 symlink/非目录 → ingest_failed）
  const rootAbs = voiceLibraryRootAbs();
  ensureSafeDir(rootAbs);
  ensureSafeDir(path.join(rootAbs, STAGING_DIR_NAME), rootAbs);
  const stagingDir = path.join(rootAbs, STAGING_DIR_NAME, crypto.randomUUID());
  fs.mkdirSync(stagingDir, {mode: 0o700});
  const originalPath = path.join(stagingDir, 'original.bin');

  return await new Promise<StagedVoiceUpload>((resolve, reject) => {
    let fd: number | null = fs.openSync(
      originalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let requestId: string | null = null;
    let transcript: string | null = null;
    let language: string | null = null;
    let originalFilename: string | null = null;
    let audioSeen = false;
    let byteLength = 0;
    let settled = false;
    const hash = crypto.createHash('sha256');

    const src = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);
    let bb: ReturnType<typeof Busboy>;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
      try {
        src.destroy();
      } catch {
        /* ignore */
      }
      try {
        bb.destroy();
      } catch {
        /* ignore */
      }
      // staging 由本模块在失败路径清理（route 在 parser 抛错时拿不到 stagingDir）；
      // 成功路径由 route 的 finally 清理。二者均只触碰 staging，绝不触碰 final 文件。
      try {
        fs.rmSync(stagingDir, {recursive: true, force: true});
      } catch {
        /* ignore */
      }
      reject(
        err instanceof VoiceLibraryError
          ? err
          : new VoiceLibraryError('invalid_formdata', 400, 'multipart 解析失败或连接中断'),
      );
    };

    const finalize = (): void => {
      if (settled) return;
      if (!audioSeen) {
        fail(new VoiceLibraryError('invalid_request', 422, '缺少音频文件字段 audio'));
        return;
      }
      if (requestId === null) {
        fail(new VoiceLibraryError('invalid_request', 422, '缺少 requestId 字段'));
        return;
      }
      settled = true;
      try {
        if (fd !== null) {
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        }
      } catch (err) {
        console.error('[voice-library] staging original fsync failed:', err);
        reject(new VoiceLibraryError('ingest_failed', 500, '上传暂存写入失败'));
        return;
      }
      fd = null;
      resolve({
        stagingDir,
        originalPath,
        originalSha256: hash.digest('hex'),
        byteLength,
        originalFilename,
        requestId,
        transcript,
        language,
      });
    };

    try {
      bb = Busboy({
        headers: {'content-type': contentType},
        limits: {
          fieldNameSize: 256,
          fieldSize: MAX_MULTIPART_FIELD_BYTES,
          // 白名单：requestId/transcript/language 3 个文本字段 + audio 1 个文件字段
          fields: MAX_MULTIPART_FIELDS - 1,
          files: 1,
          parts: MAX_MULTIPART_FIELDS,
          fileSize: MAX_REFERENCE_UPLOAD_BYTES,
        },
        defCharset: 'utf8',
        preservePath: false,
      });
    } catch (err) {
      // boundary 缺失/非法等构造期错误
      console.error('[voice-library] busboy constructor failed:', err);
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(stagingDir, {recursive: true, force: true});
      } catch {
        /* ignore */
      }
      throw new VoiceLibraryError('invalid_formdata', 400, 'multipart 解析失败（boundary 缺失或非法）');
    }

    // 流式实测字节计数（chunked / 无 Content-Length / 伪造偏小的兜底）
    let totalBytes = 0;
    src.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REFERENCE_MULTIPART_BODY_BYTES) {
        // 超限立即中止，不继续消费剩余 body
        fail(new VoiceLibraryError('body_too_large', 413, `multipart 请求体超过 ${bodyLimitMb()}MB 上限`));
      }
    });
    src.on('error', (err) => {
      // 客户端断连 / 底层流错误
      console.error('[voice-library] multipart source stream error:', err);
      fail(new VoiceLibraryError('invalid_formdata', 400, 'multipart 解析未完成（连接中断）'));
    });
    src.pipe(bb);

    bb.on('field', (name, value, _fieldnameTruncated, valueTruncated) => {
      if (valueTruncated) {
        fail(new VoiceLibraryError('invalid_request', 422, `字段 ${name} 超过长度上限`));
        return;
      }
      if (name === 'requestId') {
        if (requestId !== null) {
          fail(new VoiceLibraryError('invalid_request', 422, '重复 requestId 字段'));
          return;
        }
        requestId = value;
      } else if (name === 'transcript') {
        if (transcript !== null) {
          fail(new VoiceLibraryError('invalid_request', 422, '重复 transcript 字段'));
          return;
        }
        transcript = value;
      } else if (name === 'language') {
        if (language !== null) {
          fail(new VoiceLibraryError('invalid_request', 422, '重复 language 字段'));
          return;
        }
        language = value;
      } else if (name === 'audio') {
        // 文件字段伪装成文本字段
        fail(new VoiceLibraryError('invalid_request', 422, 'audio 必须是文件字段（不能是文本字段）'));
      } else {
        fail(new VoiceLibraryError('invalid_request', 422, `未知字段 ${name}`));
      }
    });

    bb.on('file', (name, file, filename) => {
      if (name !== 'audio') {
        // 文本字段伪装成文件 / 未知文件字段
        fail(new VoiceLibraryError('invalid_request', 422, `不允许的文件字段 ${name}`));
        return;
      }
      if (audioSeen) {
        fail(new VoiceLibraryError('invalid_request', 422, '只允许一个 audio 文件'));
        return;
      }
      audioSeen = true;
      originalFilename = typeof filename === 'string' && filename.length > 0 ? filename : null;
      file.on('data', (chunk: Buffer) => {
        byteLength += chunk.length;
        hash.update(chunk);
        if (fd !== null) {
          let offset = 0;
          while (offset < chunk.length) {
            offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
          }
        }
      });
      file.on('limit', () => {
        // 超过 fileSize 上限（busboy 已截断该文件流）→ 立即中止
        fail(new VoiceLibraryError('file_too_large', 413, `音频超过 ${fileLimitMb()}MB 上限`));
      });
      file.on('error', (err) => {
        console.error('[voice-library] multipart file stream error:', err);
        fail(new VoiceLibraryError('invalid_formdata', 400, 'multipart 文件流读取失败'));
      });
    });

    bb.on('filesLimit', () => fail(new VoiceLibraryError('invalid_request', 422, '只允许一个 audio 文件')));
    bb.on('fieldsLimit', () => fail(new VoiceLibraryError('invalid_request', 422, 'multipart 文本字段数量超限')));
    bb.on('partsLimit', () => fail(new VoiceLibraryError('invalid_request', 422, 'multipart 字段数量超限')));
    bb.on('error', (err) => {
      const code = (err as {code?: string})?.code;
      if (code === 'LIMIT_FIELD_SIZE') {
        fail(new VoiceLibraryError('invalid_request', 422, '字段超过长度上限'));
      } else {
        console.error('[voice-library] busboy parse error:', err);
        fail(new VoiceLibraryError('invalid_formdata', 400, 'multipart 解析失败'));
      }
    });
    bb.on('finish', () => finalize());
    bb.on('close', () => {
      // 未正常收尾的关闭（连接中断 / 中途销毁）
      if (!settled) fail(new VoiceLibraryError('invalid_formdata', 400, 'multipart 解析未完成（连接中断）'));
    });
  });
}
