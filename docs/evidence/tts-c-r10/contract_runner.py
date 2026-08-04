#!/usr/bin/env python3
"""TTS-C.0.R10 reproducible contract runner。

唯一 schema 来源：final 设计文档 §2（经 extract_contract.extract_section2_sql 逐字提取）。
双引擎：
  --engine python  Python sqlite3 内置库
  --engine cli     sqlite3 CLI 子进程（--sqlite-bin 指定）

用法：
  python3 docs/evidence/tts-c-r10/contract_runner.py \
    --design docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md --engine all

任一 FAIL → 非零 exit code。原始结果文件见 results-sqlite-3.45.1.txt / results-python-sqlite.txt。
"""
import argparse
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_contract import BASE_SCHEMA_SQL, extract_section2_sql  # noqa: E402

SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64
SHA_D = "d" * 64
SHA_E = "e" * 64
SHA_1 = "1" * 64
SHA_2 = "2" * 64
DBNOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"


def now_ms():
    return int(time.time() * 1000)


def iso(ms_offset=0):
    t = time.time() + ms_offset / 1000.0
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def q(s):
    """SQL 字符串字面量引用（测试数据仅含安全字符，防注入仅作保险）。"""
    return "'" + str(s).replace("'", "''") + "'"


class SqlError(Exception):
    pass


# ---------------------------------------------------------------- engines
class PyEngine:
    name = "python-sqlite"

    def __init__(self, dbfile):
        self.con = sqlite3.connect(dbfile)
        self.con.execute("PRAGMA foreign_keys=ON")
        self._changes = 0

    def version(self):
        return sqlite3.sqlite_version

    def exec(self, sql):
        try:
            cur = self.con.execute(sql)
            self._changes = cur.rowcount
            self.con.commit()
        except sqlite3.Error as e:
            self.con.rollback()
            raise SqlError(str(e))

    def execmany(self, sql):
        self.con.executescript(sql)

    def query(self, sql):
        return self.con.execute(sql).fetchall()

    def changes(self):
        return self._changes

    def close(self):
        self.con.close()


class CliEngine:
    name = "sqlite-cli"

    def __init__(self, dbfile, sqlite_bin):
        self.dbfile = dbfile
        self.bin = sqlite_bin
        self._changes = 0

    def version(self):
        out = subprocess.run([self.bin, "--version"], capture_output=True, text=True)
        return out.stdout.split()[0]

    NULL_SENTINEL = "<NULL>"

    def _run(self, sql, capture=False):
        script = ".nullvalue %s\nPRAGMA foreign_keys=ON;\n%s" % (self.NULL_SENTINEL, sql)
        p = subprocess.run([self.bin, "-batch", "-bail", "-list", self.dbfile],
                           input=script, capture_output=True, text=True)
        return p

    def exec(self, sql):
        stmt = sql.rstrip().rstrip(";") + ";"
        p = self._run(stmt + "\nSELECT '__CHANGES__=' || changes();\n")
        if p.returncode != 0:
            msg = (p.stderr or p.stdout).strip().replace("\n", " | ")
            raise SqlError(msg)
        for line in p.stdout.splitlines():
            if line.startswith("__CHANGES__="):
                self._changes = int(line.split("=", 1)[1])

    def execmany(self, sql):
        p = self._run(sql)
        if p.returncode != 0:
            msg = (p.stderr or p.stdout).strip().replace("\n", " | ")
            raise SqlError(msg)

    def query(self, sql):
        stmt = sql.rstrip().rstrip(";") + ";"
        p = self._run(stmt + "\n")
        if p.returncode != 0:
            msg = (p.stderr or p.stdout).strip().replace("\n", " | ")
            raise SqlError(msg)
        rows = []
        for line in p.stdout.splitlines():
            if line == "":
                continue
            rows.append(tuple(None if v == self.NULL_SENTINEL else v for v in line.split("|")))
        return rows

    def changes(self):
        return self._changes

    def close(self):
        pass


# ---------------------------------------------------------------- harness
class Harness:
    def __init__(self, engine, dbfile):
        self.ex = engine
        self.dbfile = dbfile

    # -- 低层
    def exec(self, sql):
        self.ex.exec(sql)

    def query(self, sql):
        return self.ex.query(sql)

    def changes(self):
        return self.ex.changes()

    def expect_abort(self, sql, needle):
        try:
            self.ex.exec(sql)
            return False, "no error raised (expected ABORT containing: %s)" % needle
        except SqlError as e:
            msg = str(e)
            return (needle in msg), msg

    def expect_abort_any(self, sql, needles):
        """同表多 trigger 按创建逆序触发（实证 3.45.1），多个冻结消息均为合法拒绝时接受其一。"""
        try:
            self.ex.exec(sql)
            return False, "no error raised (expected ABORT containing one of: %s)" % (needles,)
        except SqlError as e:
            msg = str(e)
            return any(n in msg for n in needles), msg

    # -- fixtures
    def seed_base(self, revision_number=1):
        now = iso(0)
        self.exec("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('P1','t',%s,%s)" % (q(now), q(now)))
        self.exec("INSERT INTO voice_profiles (id,schema_version,display_name,provider,created_at,updated_at)"
                  " VALUES ('VP1','voice-profile@1.0','vp','indextts2',%s,%s)" % (q(now), q(now)))
        self.exec("""INSERT INTO voice_profile_revisions
            (id,schema_version,voice_profile_id,revision_number,request_id,provider,adapter_compatibility_key,
             original_audio_sha256,canonical_audio_sha256,canonical_audio_path,codec,sample_rate,channels,
             duration_ms,metadata_json,request_fingerprint,created_at)
            VALUES ('VR1','voice-profile-revision@1.0','VP1',%d,'rq1','indextts2','ack1',%s,%s,
                    'VP1/VR1/reference.wav','pcm_s16le',48000,1,1000,'{}','fp',%s)"""
                  % (revision_number, q(SHA_A), q(SHA_A), q(now)))
        for aid, kind in (("A1", "narration_plan_v2"), ("A2", "project_voice_assignment"),
                          ("A3", "narration_performance_plan")):
            self.exec("INSERT INTO artifacts (id,project_id,kind,content_json,created_at) VALUES (%s,'P1',%s,'{}',%s)"
                      % (q(aid), q(kind), q(now)))

    def mk_claim(self, cid="C1", lease_ms=None, attempt=1, token="vowner1", unit="N001"):
        if lease_ms is None:
            lease_ms = now_ms() + 600000
        now = iso(0)
        self.exec("""INSERT INTO tts_synthesis_claims
            (id,project_id,unit_id,final_tts_input_fingerprint,generation_variant_id,status,
             validation_owner_token,validation_lease_expires_at_epoch_ms,validation_attempt,
             validation_started_at,created_at,updated_at)
            VALUES (%s,'P1',%s,%s,'default','validating_reuse',%s,%d,%d,%s,%s,%s)"""
                  % (q(cid), q(unit), q("ffp-" + cid), q(token), lease_ms, attempt, q(now), q(now), q(now)))

    def mk_subscriber(self, rid, cid, unit="N001"):
        now = iso(0)
        self.exec("""INSERT INTO tts_audio_requests
            (id,project_id,request_id,unit_id,exact_source_fingerprint,synthesis_payload_fingerprint,
             final_tts_input_fingerprint,generation_variant_id,status,created_at,updated_at)
            VALUES (%s,'P1',%s,%s,'esp','spf',%s,'default','initializing',%s,%s)"""
                  % (q(rid), q(rid), q(unit), q("ffp-" + cid), q(now), q(now)))
        self.exec("UPDATE tts_audio_requests SET claim_id=%s, status='waiting', updated_at=%s WHERE id=%s"
                  % (q(cid), q(now), q(rid)))

    def dispatch(self, cid="C1", jid="J1", did="D1", token="vowner1", attempt=1,
                 candidate=None, candidate_hash=None, rev_text="1", rev_id="VR1",
                 created=None, unit="N001"):
        if created is None:
            created = iso(0)
        cand = "NULL" if candidate is None else q(candidate)
        chash = "NULL" if candidate_hash is None else q(candidate_hash)
        self.exec("""INSERT INTO tts_claim_generation_dispatches
            (id,claim_id,job_id,validation_owner_token,validation_attempt,candidate_artifact_id,
             candidate_artifact_metadata_hash,project_id,unit_id,narration_plan_artifact_id,
             narration_plan_version,provider,voice_profile_id,voice_profile_revision,voice_profile_revision_id,
             payload_json,originating_request_id,exact_source_fingerprint,synthesis_payload_fingerprint,
             final_tts_input_fingerprint,generation_variant_id,created_at)
            VALUES (%s,%s,%s,%s,%d,%s,%s,'P1',%s,'A1',1,'indextts2','VP1',%s,%s,'{}',NULL,'esp','spf',%s,'default',%s)"""
                  % (q(did), q(cid), q(jid), q(token), attempt, cand, chash, q(unit),
                     q(rev_text), q(rev_id), q("ffp-" + cid), q(created)))

    def worker_claim(self, tid, jid="J1", cid="C1", token="w1", lease_ms=None, attempt=1,
                     claimed=None, heartbeat=None, activated=None, created=None):
        if lease_ms is None:
            lease_ms = now_ms() + 600000
        claimed = claimed or iso(0)
        heartbeat = heartbeat or iso(0)
        activated = activated or iso(0)
        created = created or iso(0)
        self.exec("""INSERT INTO tts_job_execution_transitions
            (id,transition_request_id,job_id,claim_id,command_kind,
             from_claim_status,to_claim_status,from_job_status,to_job_status,
             worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
             claimed_at,heartbeat_at,activated_at,created_at)
            VALUES (%s,%s,%s,%s,'worker_claim','generation_pending','running','queued','running',
                    %s,%d,%d,%s,%s,%s,%s)"""
                  % (q(tid), q("req-" + tid), q(jid), q(cid), q(token), lease_ms, attempt,
                     q(claimed), q(heartbeat), q(activated), q(created)))

    def state_transition(self, tid, jid="J1", cid="C1", frm="running", to="succeeded",
                         token="w1", lease_ms=None, attempt=1, result=None,
                         error_code=None, error_message=None, activated=None, created=None):
        if lease_ms is None:
            lease_ms = now_ms() + 600000
        activated = activated or iso(0)
        created = created or iso(0)
        res = "NULL" if result is None else q(result)
        ec = "NULL" if error_code is None else q(error_code)
        em = "NULL" if error_message is None else q(error_message)
        self.exec("""INSERT INTO tts_job_execution_transitions
            (id,transition_request_id,job_id,claim_id,command_kind,
             from_claim_status,to_claim_status,from_job_status,to_job_status,
             worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
             result_artifact_id,error_code,error_message,activated_at,created_at)
            VALUES (%s,%s,%s,%s,'state_transition',%s,%s,%s,%s,%s,%d,%d,%s,%s,%s,%s,%s)"""
                  % (q(tid), q("req-" + tid), q(jid), q(cid), q(frm), q(to), q(frm), q(to),
                     q(token), lease_ms, attempt, res, ec, em, q(activated), q(created)))

    def mk_materialization(self, mid="M1"):
        now = iso(0)
        self.exec("""INSERT INTO voice_materializations
            (id,voice_profile_id,voice_profile_revision_id,source_canonical_sha256,adapter_compatibility_key,
             destination_voice_root_relative_path,status,created_at,updated_at)
            VALUES (%s,'VP1','VR1',%s,'ack1','VP1/VR1/reference.wav','file_ready_unpublished',%s,%s)"""
                  % (q(mid), q(SHA_A), q(now), q(now)))

    def mk_legacy_entry(self, eid="E1", key="legacy-key-1"):
        now = iso(0)
        self.exec("""INSERT INTO legacy_adapter_voice_entries
            (id,voice_profile_key,voice_revision_key,speaker_name,reference_asset_path_or_safe_projection,
             reference_sha256,source_registry_sha256,imported_at,mapping_status)
            VALUES (%s,%s,%s,'sp','safe/proj',%s,%s,%s,'unmapped')"""
                  % (q(eid), q(key), q(key + "-rev"), q(SHA_B), q(SHA_C), q(now)))

    def entry_to_mapped_verified(self, eid, mid, mode):
        self.exec("""UPDATE legacy_adapter_voice_entries
            SET mapping_status='mapped_verified', mapped_voice_materialization_id=%s, mapping_mode=%s
            WHERE id=%s""" % (q(mid), q(mode), q(eid)))

    def entry_to_mapping_pending(self, eid, pid):
        self.exec("""UPDATE legacy_adapter_voice_entries
            SET mapping_status='mapping_pending', pending_publication_id=%s,
                candidate_source_selector='tts_a' WHERE id=%s""" % (q(pid), q(eid)))

    def entry_rollback(self, eid):
        self.exec("""UPDATE legacy_adapter_voice_entries
            SET mapping_status='mapped_verified', pending_publication_id=NULL,
                candidate_source_selector=NULL WHERE id=%s""" % q(eid))

    def mk_publication(self, pid="PUB1", subject_type="materialization_publish", subject_id="M1",
                       subject_mode="publish_and_cutover", lease_ms=None, attempt=1, owner="powner1",
                       created=None):
        if lease_ms is None:
            lease_ms = now_ms() + 600000
        created = created or iso(0)
        self.exec("""INSERT INTO voice_registry_publications
            (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
             status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
            VALUES ((SELECT COALESCE(MAX(generation),0)+1 FROM voice_registry_publications),
                    %s,%s,%s,%s,'pub@1.0','building',%s,%d,%d,%s,%s,%s)"""
                  % (q(subject_type), q(subject_id), q(subject_mode), q(SHA_D),
                     q(owner), lease_ms, attempt, q(created), q(created), q(pid)))

    def pub_to_candidate(self, pid, cand_sha=SHA_E, manifest='{"m":1}', manifest_sha=SHA_1):
        self.exec("""UPDATE voice_registry_publications SET status='candidate_persisted',
            candidate_registry_sha256=%s, candidate_manifest_json=%s, candidate_manifest_sha256=%s,
            updated_at=%s WHERE id=%s""" % (q(cand_sha), q(manifest), q(manifest_sha), q(iso(0)), q(pid)))

    def pub_to_file_durable(self, pid):
        self.exec("UPDATE voice_registry_publications SET status='file_durable', file_durable_at=%s,"
                  " updated_at=%s WHERE id=%s" % (q(iso(0)), q(iso(0)), q(pid)))

    def pub_to_activation_pending(self, pid):
        self.exec("UPDATE voice_registry_publications SET status='activation_pending',"
                  " activation_requested_at=%s, updated_at=%s WHERE id=%s" % (q(iso(0)), q(iso(0)), q(pid)))

    def pub_progress(self, pid, cand_sha=SHA_E):
        self.pub_to_candidate(pid, cand_sha)
        self.pub_to_file_durable(pid)
        self.pub_to_activation_pending(pid)

    def activate(self, pid="PUB1", aid="ACT1", owner="powner1", attempt=1, obs=SHA_E,
                 mode="normal_owner_finalize", res_ev=None, res_hash=None,
                 activated=None, created=None):
        activated = activated or iso(0)
        created = created or iso(0)
        ot = "NULL" if owner is None else q(owner)
        re_ = "NULL" if res_ev is None else q(res_ev)
        rh = "NULL" if res_hash is None else q(res_hash)
        self.exec("""INSERT INTO voice_registry_publication_activations
            (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
             activation_mode,resolution_evidence,resolution_evidence_hash,created_at)
            VALUES (%s,%s,%s,%d,%s,%s,%s,%s,%s,%s)"""
                  % (q(aid), q(pid), ot, attempt, q(obs), q(activated), q(mode), re_, rh, q(created)))

    def walk_attempt_to_succeeded(self, aid="AT1", jid="J1", provider="indextts2", model="m0"):
        """tts_generation_attempts 全 phase 走到 succeeded（符合 phase window）。"""
        now = iso(0)
        self.exec("""INSERT INTO tts_generation_attempts
            (id,job_id,attempt_number,provider,model,request_hash,request_json,execution_phase,started_at)
            VALUES (%s,%s,1,%s,%s,'rh','{}','created',%s)""" % (q(aid), q(jid), q(provider), q(model), q(now)))
        self.exec("UPDATE tts_generation_attempts SET execution_phase='provider_in_flight',"
                  " provider_request_id='pr1' WHERE id=%s" % q(aid))
        self.exec("UPDATE tts_generation_attempts SET execution_phase='response_persisted',"
                  " recovery_temp_relative_path='tmp/a.wav', response_hash=%s WHERE id=%s" % (q(SHA_B), q(aid)))
        self.exec("UPDATE tts_generation_attempts SET execution_phase='file_validated' WHERE id=%s" % q(aid))
        self.exec("""UPDATE tts_generation_attempts SET execution_phase='file_durable',
            final_relative_path='sent/N001.wav', audio_sha256=%s, output_size=100, codec='pcm_s16le',
            sample_rate=48000, channels=1, ffprobe_duration_ms=1000 WHERE id=%s""" % (q(SHA_C), q(aid)))
        self.exec("UPDATE tts_generation_attempts SET execution_phase='succeeded', finished_at=%s WHERE id=%s"
                  % (q(iso(0)), q(aid)))

    def insert_artifact(self, art_id="ART1", cid="C1", jid="J1", aid="AT1", unit="N001"):
        now = iso(0)
        self.exec("""INSERT INTO sentence_audio_artifacts
            (id,project_id,unit_id,narration_plan_artifact_id,narration_plan_content_hash,
             assignment_artifact_id,assignment_content_hash,performance_plan_artifact_id,
             performance_plan_content_hash,voice_profile_id,voice_profile_revision_id,
             canonical_audio_sha256,exact_source_fingerprint,synthesis_payload_fingerprint,
             final_tts_input_fingerprint,provider,model,capability_compiler_version,
             capability_snapshot_json,compiled_payload_json,claim_id,job_id,successful_attempt_id,
             output_relative_path,audio_sha256,output_size,codec,sample_rate,channels,
             ffprobe_duration_ms,created_at)
            VALUES (%s,'P1',%s,'A1','h1','A2','h2','A3','h3','VP1','VR1',%s,'esp','spf',%s,
                    'indextts2','m0','cc@1','{}','{}',%s,%s,%s,'sent/N001.wav',%s,100,'pcm_s16le',
                    48000,1,1000,%s)"""
                  % (q(art_id), q(unit), q(SHA_A), q("ffp-" + cid), q(cid), q(jid), q(aid), q(SHA_C), q(now)))

    # -- 组合场景
    def dispatched(self, cid="C1", jid="J1", rev_text="1", seed=True):
        """claim validating_reuse + subscriber + dispatch → claim generation_pending, job queued。"""
        if seed:
            self.seed_base()
        self.mk_claim(cid)
        self.mk_subscriber("R1-" + cid, cid)
        self.dispatch(cid, jid, "D-" + cid, rev_text=rev_text)

    def running_pair(self, cid="C1", jid="J1", token="w1", attempt=1, seed=True):
        """dispatch + worker_claim → 双侧 running。seed=False 用于同一 DB 内第二条链。"""
        self.dispatched(cid, jid, seed=seed)
        self.worker_claim("T-wc-" + jid, jid, cid, token=token, attempt=attempt)


# ---------------------------------------------------------------- test loading
def load_tests(evidence_dir):
    modules = ["test_js", "test_lc", "test_tf", "test_ie", "test_vi", test_regress_name()]
    tests = []
    for name in modules:
        path = os.path.join(evidence_dir, name + ".py")
        if not os.path.exists(path):
            continue
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for tid, desc, fn in mod.TESTS:
            tests.append((tid, desc, fn))
    return tests


def test_regress_name():
    return "test_regress"


# ---------------------------------------------------------------- runner
def build_db(engine_kind, sqlite_bin, contract_sql, tmpdir):
    if engine_kind == "python":
        ex = PyEngine(":memory:")
        dbfile = None
    else:
        fd, dbfile = tempfile.mkstemp(suffix=".db", dir=tmpdir)
        os.close(fd)
        os.unlink(dbfile)
        ex = CliEngine(dbfile, sqlite_bin)
    # 测试专用临时 DB：关闭 fsync/日志持久化以消除 I/O 抖动（与 contract 语义无关）
    ex.exec("PRAGMA synchronous=OFF")
    ex.exec("PRAGMA journal_mode=MEMORY")
    ex.execmany("PRAGMA foreign_keys=ON;\n" + BASE_SCHEMA_SQL)
    ex.execmany(contract_sql)
    return ex, dbfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--design", required=True)
    ap.add_argument("--engine", choices=["python", "cli", "all"], default="all")
    ap.add_argument("--sqlite-bin", default="sqlite3")
    ap.add_argument("--results-dir", default=None,
                    help="写 results-*.txt 到该目录（默认 = runner 所在目录）")
    args = ap.parse_args()

    evidence_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = args.results_dir or evidence_dir
    info = extract_section2_sql(args.design)
    contract_sql = info["sql"]

    engines = ["python", "cli"] if args.engine == "all" else [args.engine]
    overall_rc = 0
    for kind in engines:
        rc = run_engine(kind, args, info, contract_sql, evidence_dir, results_dir)
        overall_rc = overall_rc or rc
    return overall_rc


def run_engine(kind, args, info, contract_sql, evidence_dir, results_dir):
    tests = load_tests(evidence_dir)
    log = []
    results = []
    git_head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    import hashlib
    design_sha = hashlib.sha256(open(args.design, "rb").read()).hexdigest()

    with tempfile.TemporaryDirectory(prefix="ttsc-r10-") as tmpdir:
        # schema 验证（一次性）
        ex, dbfile = build_db(kind, args.sqlite_bin, contract_sql, tmpdir)
        ver = ex.version()
        fkc = ex.query("PRAGMA foreign_key_check")
        ic = ex.query("PRAGMA integrity_check")
        tabs = ex.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        trgs = ex.query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        idxs = ex.query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        ex.close()
        if dbfile and os.path.exists(dbfile):
            os.unlink(dbfile)

        npass = nfail = 0
        for tid, desc, fn in tests:
            ex, dbfile = build_db(kind, args.sqlite_bin, contract_sql, tmpdir)
            h = Harness(ex, dbfile)
            try:
                fn(h)
                ok, detail = True, ""
            except SqlError as e:
                ok, detail = False, "UNEXPECTED-ABORT: " + str(e)[:300]
            except AssertionError as e:
                ok, detail = False, "ASSERT: " + str(e)[:300]
            except Exception as e:
                ok, detail = False, "ERROR(%s): %s" % (type(e).__name__, str(e)[:300])
            finally:
                ex.close()
                if dbfile and os.path.exists(dbfile):
                    os.unlink(dbfile)
            results.append((tid, desc, ok, detail))
            npass += 1 if ok else 0
            nfail += 0 if ok else 1

    engine_label = "python-sqlite" if kind == "python" else "sqlite-cli"
    log.append("TTS-C.0.R10 contract validation results")
    log.append("engine                 : %s" % engine_label)
    log.append("engine sqlite version  : %s" % ver)
    log.append("python sqlite3 version : %s" % sqlite3.sqlite_version)
    log.append("git HEAD               : %s" % git_head)
    log.append("design doc             : %s" % os.path.abspath(args.design))
    log.append("design doc sha256      : %s" % design_sha)
    log.append("extracted §2 sql sha256: %s" % info["sha256"])
    log.append("§2 section lines       : %s..%s" % info["section_lines"])
    log.append("§2 sql blocks          : %d" % info["blocks"])
    log.append("§2 CREATE TABLE        : %d" % info["create_table"])
    log.append("§2 CREATE TRIGGER      : %d" % info["create_trigger"])
    log.append("§2 CREATE UNIQUE INDEX : %d" % info["create_unique_index"])
    log.append("§2 ALTER TABLE         : %d" % info["alter_table"])
    log.append("contract tables (12 new + tts_jobs migrated = 13): %s" % ",".join(info["created_tables"]))
    log.append("missing base parents (fixture-provided): %s" % ",".join(info["missing_parents"]))
    log.append("db tables total        : %d" % len(tabs))
    log.append("db triggers total      : %d" % len(trgs))
    log.append("db indexes total       : %d" % len(idxs))
    log.append("foreign_key_check rows : %d" % len(fkc))
    log.append("integrity_check        : %s" % (ic[0][0] if ic else "?"))
    log.append("generated_at           : %s" % iso(0))
    log.append("")
    for tid, desc, ok, detail in results:
        line = "[%s] %-8s %s" % ("PASS" if ok else "FAIL", tid, desc)
        if detail:
            line += "  -- " + detail
        log.append(line)
    log.append("")
    log.append("TOTAL=%d PASS=%d FAIL=%d SKIP=0" % (len(results), npass, nfail))
    log.append("EA-01 runner final FAIL=0: %s" % ("YES" if nfail == 0 else "NO"))
    log.append("EA-03 PASS+FAIL+SKIP = TOTAL: %s" % ("YES" if npass + nfail == len(results) else "NO"))

    out_name = "results-python-sqlite.txt" if kind == "python" else "results-sqlite-3.45.1.txt"
    os.makedirs(results_dir, exist_ok=True)
    out_path = os.path.join(results_dir, out_name)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log[-(len(results) + 4):]))
    print("results written: %s" % out_path)
    return 0 if nfail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
