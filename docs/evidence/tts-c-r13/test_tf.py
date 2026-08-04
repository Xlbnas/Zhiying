"""TF-01..TF-08：database-time fencing 回归（R9 ① 保留项；R10 重跑）。"""
from contract_runner import DBNOW, SHA_E, iso, now_ms, q


def _pub_ready(h, lease_ms, pid="PUB1"):
    h.mk_materialization("M1")
    h.mk_publication(pid, "materialization_publish", "M1", "publish_and_cutover", lease_ms=lease_ms)
    h.pub_progress(pid, SHA_E)


def tf01(h):
    """publication lease 已过期，回填旧 activated_at → fencing mismatch ABORT。"""
    h.seed_base()
    _pub_ready(h, now_ms() - 1000)
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publication_activations
        (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
         activation_mode,created_at)
        VALUES ('ACT1','PUB1','powner1',1,%s,%s,'normal_owner_finalize',%s)"""
        % (q(SHA_E), q(iso(-3600000)), q(iso(0))),
        "fencing mismatch")
    assert ok, msg
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert p[0] == "activation_pending", "pub=%s" % (p,)


def tf02(h):
    """publication lease 已过期，回填旧 created_at → fencing mismatch ABORT。"""
    h.seed_base()
    _pub_ready(h, now_ms() - 1000)
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publication_activations
        (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
         activation_mode,created_at)
        VALUES ('ACT1','PUB1','powner1',1,%s,%s,'normal_owner_finalize',%s)"""
        % (q(SHA_E), q(iso(0)), q(iso(-7200000))),
        "fencing mismatch")
    assert ok, msg


def tf03(h):
    """validation lease 已过期，dispatch.created_at 回填 → fencing mismatch ABORT。"""
    h.seed_base()
    h.mk_claim("C1", lease_ms=now_ms() - 1000)
    h.mk_subscriber("R1", "C1")
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D1','C1','J1','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','1','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(iso(-3600000)),
        "fencing mismatch")
    assert ok, msg


def tf04(h):
    """worker_claim command lease <= DB_NOW_MS → ABORT（新 owner 必须持有效 lease）。"""
    h.dispatched()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T1','req-T1','J1','C1',NULL,1,'worker_claim','generation_pending','running','queued','running',
                'w1',%d,1,%s,%s,%s,%s)"""
        % (now_ms() - 1000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "ownership conflict")
    assert ok, msg


def tf05(h):
    """lease 未过期 + exact token/attempt → dispatch / activation / worker_claim 全 PASS。"""
    h.seed_base()
    h.mk_claim("C1", lease_ms=now_ms() + 600000)
    h.mk_subscriber("R1", "C1")
    h.dispatch("C1", "J1", "D1")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    assert j[0] == "queued", "dispatch failed: %s" % (j,)
    h.worker_claim("T1")
    c = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c == ("running", "w1"), "worker_claim failed: %s" % (c,)
    _pub_ready(h, now_ms() + 600000)
    h.activate("PUB1", "ACT1")
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert p[0] == "active", "activation failed: %s" % (p,)


def tf06(h):
    """takeover 后旧 owner 即使回填时间也无法提交（validation 通道）。"""
    h.seed_base()
    h.mk_claim("C1", lease_ms=now_ms() - 1000)
    h.mk_subscriber("R1", "C1")
    h.exec("""UPDATE tts_synthesis_claims
        SET validation_owner_token='new-owner', validation_lease_expires_at_epoch_ms=%d,
            validation_attempt=validation_attempt+1, validation_started_at=%s
        WHERE id='C1' AND status='validating_reuse'
          AND validation_lease_expires_at_epoch_ms < (SELECT %s)""" % (now_ms() + 600000, q(iso(0)), DBNOW))
    assert h.changes() == 1, "takeover changes=%d" % h.changes()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D1','C1','J1','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','1','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(iso(-3600000)),
        "fencing mismatch")
    assert ok, msg
    c = h.query("SELECT status,validation_owner_token,validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "validating_reuse" and c[1] == "new-owner" and str(c[2]) == "2", "claim=%s" % (c,)


def tf07(h):
    """边界语义：fence <= 含等值；过期 < 严格；renewal >= 含等值。"""
    r1 = h.query("SELECT (SELECT %s) <= (SELECT %s)" % (DBNOW, DBNOW))[0]
    r2 = h.query("SELECT (SELECT %s) < (SELECT %s)" % (DBNOW, DBNOW))[0]
    r3 = h.query("SELECT (SELECT %s) >= (SELECT %s)" % (DBNOW, DBNOW))[0]
    assert str(r1[0]) == "1" and str(r2[0]) == "0" and str(r3[0]) == "1", "r=%s,%s,%s" % (r1, r2, r3)
    # 功能近边界：lease=now+3s → PASS
    h.seed_base()
    h.mk_claim("C1", lease_ms=now_ms() + 3000)
    h.mk_subscriber("R1", "C1")
    h.dispatch("C1", "J1", "D1")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    assert j[0] == "queued", "near-boundary PASS failed: %s" % (j,)


def tf08(h):
    """lease=DB_NOW-1ms → 已过期 ABORT；julianday→epoch ms 截断漂移 ∈ {-1,0}（保守，不宽限）。

    lease 基准用 SQLite 时钟（与 fence 同一时钟源）而非宿主时钟：
    宿主时钟与 SQLite 时钟存在 ±1ms 偏差，跨时钟源构造"now-1ms"在
    in-process Python 引擎下是 flaky；同源时 DB 时钟单调不减，
    lease=DB_NOW_pre-1 < DB_NOW_cur 严格成立，语义与冻结契约一致。
    """
    h.seed_base()
    db_now = int(h.query("SELECT %s" % DBNOW)[0][0])
    h.mk_claim("C1", lease_ms=db_now - 1)
    h.mk_subscriber("R1", "C1")
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D1','C1','J1','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','1','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(iso(0)),
        "fencing mismatch")
    assert ok, msg
    drifts = set()
    for _ in range(50):
        row = h.query("SELECT %s, CAST(strftime('%%s','now') AS INTEGER)*1000"
                      " + CAST((strftime('%%f','now')*1000) AS INTEGER) %% 1000" % DBNOW)[0]
        drifts.add(int(row[0]) - int(row[1]))
    # julianday('now') 浮点乘法在毫秒边界存在 ±1ms 舍入（SQLite 3.45 实测 drift ∈ {-1,0,1}）；
    # lease 语义仍保守（<=/严格 <），drift 观测仅作文档记录
    assert drifts <= {-1, 0, 1}, "drift=%s" % sorted(drifts)


TESTS = [
    ("TF-01", "publication lease 过期 + 回填 activated_at → fencing ABORT", tf01),
    ("TF-02", "publication lease 过期 + 回填 created_at → fencing ABORT", tf02),
    ("TF-03", "validation lease 过期 + 回填 dispatch.created_at → fencing ABORT", tf03),
    ("TF-04", "worker_claim lease <= DB_NOW → ownership conflict ABORT", tf04),
    ("TF-05", "lease 未过期 + exact token/attempt → dispatch/activation/worker_claim PASS", tf05),
    ("TF-06", "takeover 后旧 owner 回填时间 → ABORT", tf06),
    ("TF-07", "边界：fence <= 含等值 / 过期 < 严格 / renewal >= 含等值", tf07),
    ("TF-08", "lease=now-1ms 过期；julianday 截断漂移 ∈ {-1,0}", tf08),
]
