"""JS-01..JS-17：tts_job_execution_transitions 全生命周期（R10 ⑥）。

worker_claim 首次 ownership establishment + state_transition owner fencing +
多 transition append-only 生命周期。
"""
from contract_runner import DBNOW, iso, now_ms, q


def js01(h):
    h.dispatched()
    ok, msg = h.expect_abort("UPDATE tts_jobs SET status='running' WHERE id='J1'",
                             "state transition requires execution command")
    assert ok, msg


def js02(h):
    h.dispatched()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET status='running', owner_token='w1',"
        " lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() + 600000),
        "state transition requires execution command")
    assert ok, msg


def js03(h):
    """worker claim command → claim/job 同时 running（R9 P0-1 修复实证）。"""
    h.dispatched()
    h.worker_claim("T1")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "running" and c[0] == "running", "job=%s claim=%s" % (j, c)


def js04(h):
    """worker claim command 建立双侧 owner/lease/attempt/claimed_at/heartbeat/started_at。"""
    h.dispatched()
    lease = now_ms() + 600000
    h.worker_claim("T1", token="w1", lease_ms=lease, attempt=1)
    j = h.query("SELECT claimed_by,claimed_at,heartbeat_at,attempt,started_at FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT owner_token,lease_expires_at_epoch_ms,validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "w1" and j[1] and j[2] and str(j[3]) == "1" and j[4], "job=%s" % (j,)
    assert c[0] == "w1" and str(c[1]) == str(lease) and str(c[2]) == "1", "claim=%s" % (c,)


def js05(h):
    """第二个并发 worker_claim（双方已有 owner / 状态已走）→ ABORT，恰好一个 running owner。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','worker_claim','generation_pending','running','queued','running',
                'w2',%d,1,%s,%s,%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "tts_job_execution_transitions")
    assert ok, msg
    j = h.query("SELECT status,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    assert j == ("running", "w1"), "job=%s" % (j,)


def _full_success(h):
    h.running_pair()
    h.walk_attempt_to_succeeded()
    h.insert_artifact()


def js06(h):
    """running→succeeded 第二条 command → PASS（完整链：dispatch→worker_claim→attempt→artifact→command）。"""
    _full_success(h)
    h.state_transition("T2", to="succeeded", result="ART1")
    j = h.query("SELECT status,result_artifact_id,claimed_by,finished_at FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,result_artifact_id,owner_token,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "succeeded" and j[1] == "ART1" and j[2] is None and j[3], "job=%s" % (j,)
    assert c[0] == "succeeded" and c[1] == "ART1" and c[2] is None and c[3] is None, "claim=%s" % (c,)
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE job_id='J1'")[0]
    assert str(n[0]) == "2", "command rows=%s（多 transition 生命周期，R9 P0-2 修复实证）" % (n,)


def js07(h):
    h.running_pair()
    h.state_transition("T2", to="failed", error_code="E1", error_message="boom")
    j = h.query("SELECT status,error_code,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "failed" and j[1] == "E1" and j[2] is None, "job=%s" % (j,)
    assert c == ("failed", None), "claim=%s" % (c,)


def js08(h):
    h.running_pair()
    h.state_transition("T2", to="cancelled", error_code="CANCEL", error_message="user")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "cancelled" and c[0] == "cancelled", "job=%s claim=%s" % (j, c)


def js09(h):
    """running→indeterminate 保留双侧 owner/lease（供 resolve fence）。"""
    h.running_pair()
    h.state_transition("T2", to="indeterminate", error_code="UNK", error_message="crash?")
    j = h.query("SELECT status,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j == ("indeterminate", "w1"), "job=%s" % (j,)
    assert c[0] == "indeterminate" and c[1] == "w1" and c[2] is not None, "claim=%s" % (c,)


def js10(h):
    """indeterminate→failed 第三条 command → PASS。"""
    h.running_pair()
    h.state_transition("T2", to="indeterminate", error_code="UNK", error_message="crash?")
    h.state_transition("T3", frm="indeterminate", to="failed", error_code="E2", error_message="confirmed")
    j = h.query("SELECT status,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE job_id='J1'")[0]
    assert j == ("failed", None) and c == ("failed", None), "job=%s claim=%s" % (j, c)
    assert str(n[0]) == "3", "command rows=%s" % (n,)


def js11(h):
    """duplicate transition_request_id → UNIQUE 拒绝。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T9','req-T-wc-J1','J9','C9','worker_claim','generation_pending','running','queued','running',
                'w9',%d,1,%s,%s,%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "UNIQUE constraint failed: tts_job_execution_transitions.transition_request_id")
    assert ok, msg


def js11b(h):
    """完全相同 transition replay（同 from/to/attempt，不同 request id）→ 语义 UNIQUE 拒绝。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T9','req-T9','J1','C1','worker_claim','generation_pending','running','queued','running',
                'w2',%d,1,%s,%s,%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "tts_job_execution_transitions")
    assert ok, msg


def js12(h):
    """同 job 不同阶段 command 连续提交且 evidence 全保留。"""
    _full_success(h)
    h.state_transition("T2", to="succeeded", result="ART1")
    rows = h.query("SELECT from_job_status,to_job_status FROM tts_job_execution_transitions WHERE job_id='J1' ORDER BY created_at")
    assert len(rows) == 2 and ("queued", "running") in rows and ("running", "succeeded") in rows, "rows=%s" % (rows,)


def js13(h):
    """succeeded command 携带属于其他 job 的 artifact → identity mismatch ABORT + 回滚。"""
    _full_success(h)  # ART1 属于 J1/C1
    # 第二个完整 running 链（另一 claim/job；unit 复用 N001 但 fingerprint 不同，不冲突）
    h.running_pair("C2", "J2", seed=False)
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         result_artifact_id,activated_at,created_at)
        VALUES ('T2','req-T2','J2','C2','state_transition','running','succeeded','running','succeeded',
                'w1',%d,1,'ART1',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0))),
        "result artifact identity mismatch")
    assert ok, msg
    j2 = h.query("SELECT status FROM tts_jobs WHERE id='J2'")[0]
    assert j2[0] == "running", "J2 应保持 running（回滚）：%s" % (j2,)


def js14(h):
    """succeeded command 但 artifact 不存在 → 整条 statement 回滚：claim/job 保持 running。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         result_artifact_id,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','state_transition','running','succeeded','running','succeeded',
                'w1',%d,1,'ART-X',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0))),
        "result artifact identity mismatch")
    assert ok, msg
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert j[0] == "running" and c[0] == "running" and str(n[0]) == "0", "job=%s claim=%s rows=%s" % (j, c, n)


def js15(h):
    """from-state 任一不匹配 → ABORT。"""
    h.dispatched()  # job queued，但 command 声称 from running
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T1','req-T1','J1','C1','state_transition','running','failed','running','failed',
                'w1',%d,1,'E1',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0))),
        "job claim mismatch")
    assert ok, msg


def js16(h):
    """expired running owner（claim lease 已过期）→ state_transition fencing ABORT。"""
    h.running_pair()
    h.exec("UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() - 1000))
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','state_transition','running','failed','running','failed',
                'w1',%d,1,'E1',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg


def js17(h):
    """execution takeover CAS（§3.6）后：旧 owner transition ABORT；新 owner transition PASS。"""
    h.running_pair()
    h.exec("UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() - 1000))
    # takeover CAS（同事务两条 fenced UPDATE）
    h.exec("""UPDATE tts_synthesis_claims
        SET owner_token='w2', lease_expires_at_epoch_ms=%d, validation_attempt=validation_attempt+1,
            updated_at=%s
        WHERE id='C1' AND status IN ('running','indeterminate')
          AND lease_expires_at_epoch_ms < (SELECT %s)""" % (now_ms() + 600000, q(iso(0)), DBNOW))
    assert h.changes() == 1, "claim takeover changes=%d" % h.changes()
    h.exec("""UPDATE tts_jobs
        SET claimed_by='w2', claimed_at=%s, heartbeat_at=%s, attempt=attempt+1
        WHERE claim_id='C1' AND status IN ('running','indeterminate') AND claimed_by IS NOT NULL"""
           % (q(iso(0)), q(iso(0))))
    assert h.changes() == 1, "job takeover changes=%d" % h.changes()
    # 旧 owner transition → ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','state_transition','running','failed','running','failed',
                'w1',%d,1,'E1',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    # 新 owner（attempt=2）transition → PASS
    h.state_transition("T3", to="failed", token="w2", attempt=2, error_code="E2", error_message="took over")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "failed" and c[0] == "failed", "job=%s claim=%s" % (j, c)


TESTS = [
    ("JS-01", "job queued→running 直接 UPDATE → command required ABORT", js01),
    ("JS-02", "claim generation_pending→running 直接 UPDATE → command required ABORT", js02),
    ("JS-03", "worker claim command → claim/job 同时 running（R9 P0-1 修复）", js03),
    ("JS-04", "worker claim command 建立双侧 owner/lease/attempt/claimed_at/heartbeat", js04),
    ("JS-05", "并发第二 worker_claim → ABORT，恰好一个 running owner", js05),
    ("JS-06", "running→succeeded 第二条 command 全链 PASS（R9 P0-2 修复）", js06),
    ("JS-07", "running→failed 第二条 command → PASS", js07),
    ("JS-08", "running→cancelled 第二条 command → PASS", js08),
    ("JS-09", "running→indeterminate 保留双侧 owner/lease", js09),
    ("JS-10", "indeterminate→failed 第三条 command → PASS", js10),
    ("JS-11", "duplicate transition_request_id → UNIQUE 拒绝", js11),
    ("JS-11b", "完全相同 transition replay → 语义 UNIQUE/状态 ABORT", js11b),
    ("JS-12", "同 job 多阶段 command 连续提交且 evidence 全保留", js12),
    ("JS-13", "succeeded result artifact identity 不匹配 → ABORT", js13),
    ("JS-14", "中间步骤失败整条 command statement 回滚", js14),
    ("JS-15", "from-state 任一不匹配 → ABORT", js15),
    ("JS-16", "expired running owner → fencing ABORT", js16),
    ("JS-17", "execution takeover 后旧 owner ABORT / 新 owner PASS", js17),
]
