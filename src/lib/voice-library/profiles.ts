/**
 * TTS-A Voice Profile CRUD（设计文档 §3）。
 * - Profile：稳定库实体；provider 固定 'indextts2'。
 * - archive 只影响可见性与是否可新增 revision；不删 revision；无 global default。
 */
import crypto from 'node:crypto';
import {getDb} from '@/lib/db';
import {
  DESCRIPTION_MAX,
  DISPLAY_NAME_MAX,
  VOICE_PROFILE_SCHEMA_VERSION,
  VOICE_PROVIDER,
} from './constants';
import {VoiceLibraryError, type VoiceProfileRow} from './types';

/** 创建 Profile。displayName trim 后 1..80；description ≤ 500；未知字段已由 zod strict 拒绝。 */
export function createVoiceProfile(input: {
  displayName: string;
  description?: string;
}): VoiceProfileRow {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
    throw new VoiceLibraryError(
      'invalid_request',
      422,
      `displayName trim 后必须为 1..${DISPLAY_NAME_MAX} 字符`,
    );
  }
  const description = input.description ?? null;
  if (description !== null && description.length > DESCRIPTION_MAX) {
    throw new VoiceLibraryError(
      'invalid_request',
      422,
      `description 长度超过上限 ${DESCRIPTION_MAX}`,
    );
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO voice_profiles
         (id, schema_version, display_name, provider, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, VOICE_PROFILE_SCHEMA_VERSION, displayName, VOICE_PROVIDER, description, now, now);
  const row = getVoiceProfile(id);
  if (!row) throw new VoiceLibraryError('ingest_failed', 500, 'voice profile insert failed');
  return row;
}

export function getVoiceProfile(id: string): VoiceProfileRow | null {
  const row = getDb()
    .prepare('SELECT * FROM voice_profiles WHERE id = ?')
    .get(id) as VoiceProfileRow | undefined;
  return row ?? null;
}

export function listVoiceProfiles(filter?: {
  status?: 'active' | 'archived';
}): VoiceProfileRow[] {
  if (filter?.status) {
    return getDb()
      .prepare('SELECT * FROM voice_profiles WHERE status = ? ORDER BY created_at ASC')
      .all(filter.status) as VoiceProfileRow[];
  }
  return getDb()
    .prepare('SELECT * FROM voice_profiles ORDER BY created_at ASC')
    .all() as VoiceProfileRow[];
}

/** 切换 active/archived；更新 updated_at。archive 不删除任何 revision。 */
export function setVoiceProfileStatus(
  id: string,
  status: 'active' | 'archived',
): VoiceProfileRow | null {
  const db = getDb();
  const existing = getVoiceProfile(id);
  if (!existing) return null;
  db.prepare('UPDATE voice_profiles SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id,
  );
  return getVoiceProfile(id);
}
