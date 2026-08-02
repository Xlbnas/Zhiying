/**
 * Voice Library API 共用错误映射（TTS-A）。
 * Next.js route 文件只允许导出 HTTP 方法等固定字段，故 helper 放这里。
 */
import {ZodError} from 'zod';
import {VoiceLibraryError} from '@/lib/voice-library/types';
import {jsonError} from '../_lib/shared';

export function voiceLibraryErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof VoiceLibraryError) {
    return jsonError(err.httpStatus, err.code, {message: err.message});
  }
  throw err;
}
