import {z} from 'zod';
import {subtitleCueSchema, type SubtitleCue} from '../scene-schema';
import type {SubtitleTiming} from './schema';
import type {SubtitleTimingV2} from './schema-v2';

export interface SubtitleSidecarFiles {
  'subtitles.zh-CN.srt': string;
  'subtitles.zh-CN.vtt': string;
  'subtitles.zh-CN.ass': string;
  'subtitle_timing_v2.json': string;
}

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

function formatVttTimestamp(ms: number): string {
  return formatSrtTimestamp(ms).replace(',', '.');
}

function formatAssTimestamp(ms: number): string {
  const totalCentiseconds = Math.round(ms / 10);
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000);
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\N').replace(/\{/g, '\\{');
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

export function formatSubtitleTimingV2AsSrt(timing: SubtitleTimingV2): string {
  return timing.cues
    .map((cue) => `${cue.id}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join('\n');
}

export function formatSubtitleTimingV2AsVtt(timing: SubtitleTimingV2): string {
  const cues = timing.cues
    .map((cue) => `${cue.id}\n${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}

/**
 * ASS itself stores centiseconds. Each Dialogue is therefore paired with an
 * exact millisecond Comment copied from the canonical artifact; SRT/VTT/JSON
 * retain millisecond timestamps directly.
 */
export function formatSubtitleTimingV2AsAss(timing: SubtitleTimingV2): string {
  const header = `[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,42,&H00F1EEE8,&H00F1EEE8,&H78000000,&H52000000,0,0,0,0,100,100,0,0,3,1,0,2,100,100,58,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = timing.cues.map((cue) => {
    const exact = `Comment: 0,${formatAssTimestamp(cue.startMs)},${formatAssTimestamp(cue.endMs)},Default,ExactTiming,0,0,0,exact-ms:${cue.startMs}-${cue.endMs},${cue.segmentId}`;
    const dialogue = `Dialogue: 0,${formatAssTimestamp(cue.startMs)},${formatAssTimestamp(cue.endMs)},Default,,0,0,0,,${escapeAssText(cue.text)}`;
    return `${exact}\n${dialogue}`;
  }).join('\n');
  return `${header}${events}\n`;
}

export function buildSubtitleTimingV2Sidecars(timing: SubtitleTimingV2): SubtitleSidecarFiles {
  return {
    'subtitles.zh-CN.srt': formatSubtitleTimingV2AsSrt(timing),
    'subtitles.zh-CN.vtt': formatSubtitleTimingV2AsVtt(timing),
    'subtitles.zh-CN.ass': formatSubtitleTimingV2AsAss(timing),
    'subtitle_timing_v2.json': `${JSON.stringify(timing, null, 2)}\n`,
  };
}
