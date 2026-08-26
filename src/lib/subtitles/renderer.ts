import {z} from 'zod';
import {subtitleCueSchema, type SubtitleCue} from '../scene-schema';
import type {SubtitleTiming} from './schema';
import type {SubtitleTimingV2} from './schema-v2';

/**
 * Renderer Adapter（M3-C §十一）：Subtitle Timing（整数毫秒内部真相）
 * → 现有 Renderer SubtitleCue（秒）。pure，不接 Render Bridge——
 * 本轮只证明契约兼容（z.array(subtitleCueSchema).parse），M3-D 再真正送入 renderer。
 */
export function toRendererSubtitleCues(timing: SubtitleTiming): SubtitleCue[] {
  return z.array(subtitleCueSchema).parse(
    timing.cues.map((cue) => ({
      id: cue.id,
      segmentId: cue.segmentId,
      chapter: cue.chapter,
      text: cue.text,
      start: cue.startMs / 1000,
      end: cue.endMs / 1000,
      position: cue.position,
    })),
  );
}

/** V2 exact timing uses the same renderer cue contract; unitId remains provenance-only. */
export function toRendererSubtitleCuesV2(timing: SubtitleTimingV2): SubtitleCue[] {
  return z.array(subtitleCueSchema).parse(
    timing.cues.map((cue) => ({
      id: cue.id,
      segmentId: cue.segmentId,
      chapter: cue.chapter,
      text: cue.text,
      start: cue.startMs / 1000,
      end: cue.endMs / 1000,
      position: cue.position,
    })),
  );
}

function formatSrtTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/**
 * SRT 导出（§三十六）：pure 展示层派生，非 source of truth——
 * JSON Subtitle Timing 才是 current truth，SRT 不落库、不参与 current 判定。
 */
export function formatSubtitleTimingAsSrt(timing: SubtitleTiming): string {
  return timing.cues
    .map(
      (cue) =>
        `${cue.id}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}
