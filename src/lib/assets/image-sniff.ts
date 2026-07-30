/**
 * 上传图片内容嗅探（magic bytes）。
 *
 * 浏览器对部分文件自报 `application/octet-stream` 或错误 MIME，
 * 因此上传验证以文件内容为权威依据，不信任 declared MIME / 扩展名纸面信息。
 */

export type SniffedImageType = 'jpeg' | 'png' | 'webp';

export interface SniffedImage {
  type: SniffedImageType;
  mime: string;
  ext: string;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** 文件名扩展名白名单（小写归一；仅作辅助信号，权威判定看 magic bytes）。 */
export function hasAllowedExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_IMAGE_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

/** 识别 buffer 的真实图片类型；不可识别返回 null。 */
export function sniffImageType(buf: Buffer): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= PNG_SIG.length && PNG_SIG.every((b, i) => buf[i] === b)) {
    return {type: 'png', mime: 'image/png', ext: 'png'};
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return {type: 'jpeg', mime: 'image/jpeg', ext: 'jpg'};
  }
  // WebP: 'RIFF' (0-3) + 'WEBP' (8-11)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return {type: 'webp', mime: 'image/webp', ext: 'webp'};
  }
  return null;
}
