#!/usr/bin/env python3
"""TTS-C.0.R10 contract extraction：只从 final 设计文档 §2 提取可执行 SQL。

不维护任何手写 schema 副本；contract SQL 的唯一来源 =
docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md 的 §2（'## 2. ' 到 '## 3. ' 之间）全部 ```sql 代码块。
"""
import hashlib
import re


def extract_section2_sql(design_path: str) -> dict:
    text = open(design_path, encoding="utf-8").read()
    lines = text.split("\n")
    start = next(i for i, l in enumerate(lines) if l.startswith("## 2. "))
    end = next(i for i, l in enumerate(lines) if l.startswith("## 3. "))
    sec = lines[start:end]

    blocks = []
    in_block = False
    cur = []
    for idx, l in enumerate(sec, start=start + 1):
        if not in_block and l.strip().startswith("```sql"):
            in_block = True
            cur = []
        elif in_block and l.strip().startswith("```"):
            blocks.append("\n".join(cur))
            in_block = False
        elif in_block:
            cur.append(l)

    combined = "\n\n".join(blocks)
    created = sorted(set(re.findall(r"CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)", combined)))
    altered = sorted(set(re.findall(r"ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)", combined)))
    refs = sorted(set(re.findall(r"REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)", combined)))
    return {
        "sql": combined,
        "sha256": hashlib.sha256(combined.encode("utf-8")).hexdigest(),
        "blocks": len(blocks),
        "create_table": combined.count("CREATE TABLE"),
        "create_trigger": combined.count("CREATE TRIGGER"),
        "create_unique_index": combined.count("CREATE UNIQUE INDEX"),
        "alter_table": combined.count("ALTER TABLE"),
        "created_tables": created,
        "altered_tables": altered,
        "referenced_parents": refs,
        "missing_parents": sorted(set(refs) - set(created) - set(altered)),
        "section_lines": (start + 1, end + 1),
    }


# 既有真实基座表（非 contract 一部分；按设计文档 §1/§2.0 与 src/lib/db.ts 逐列构造的
# 最小真实 base schema fixture——§2 是面向既有 DB 的 migration contract，§2 自身不含这些
# 表的 CREATE 语句；此处仅复刻既有生产 schema 的相关列，不属于"另一份 contract 副本"）。
BASE_SCHEMA_SQL = """
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rigorous',
  schema_version TEXT NOT NULL DEFAULT '1.0',
  template_version TEXT NOT NULL DEFAULT 'freud-mg-v1.0',
  composition_id TEXT NOT NULL DEFAULT 'ZhiyingFullCut',
  current_stage TEXT NOT NULL DEFAULT 'scenes',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content_json TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tts_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  narration_plan_artifact_id TEXT NOT NULL,
  narration_plan_version INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL,
  output_path TEXT,
  duration_ms INTEGER,
  audio_sha256 TEXT,
  result_json TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  progress REAL DEFAULT 0,
  error_code TEXT, error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tts_jobs_project_unit ON tts_jobs (project_id, unit_id, status);
CREATE TABLE voice_profiles (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE voice_profile_revisions (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  voice_profile_id TEXT NOT NULL REFERENCES voice_profiles(id),
  revision_number INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter_compatibility_key TEXT NOT NULL,
  original_audio_sha256 TEXT NOT NULL,
  canonical_audio_sha256 TEXT NOT NULL,
  original_filename_display TEXT,
  canonical_audio_path TEXT NOT NULL,
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  transcript TEXT,
  language TEXT,
  metadata_json TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(voice_profile_id, revision_number),
  UNIQUE(voice_profile_id, request_id)
);
CREATE TRIGGER voice_profile_revisions_update_abort BEFORE UPDATE ON voice_profile_revisions
BEGIN SELECT RAISE(ABORT, 'voice_profile_revisions is immutable'); END;
CREATE TRIGGER voice_profile_revisions_delete_abort BEFORE DELETE ON voice_profile_revisions
BEGIN SELECT RAISE(ABORT, 'voice_profile_revisions is immutable'); END;
"""
