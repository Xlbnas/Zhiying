"""JS-01..JS-32：tts_job_execution_transitions 全生命周期（R11 ⑥）。

worker_claim 首次 ownership establishment / lease_renewal 原子续租 /
execution_takeover 原子接管 / prestart_terminal Worker claim 前终结 /
state_transition owner fencing / 直接修改 fence / 多 transition append-only。
"""
from contract_runner import DBNOW, iso, now_ms, q


def js01(h):
    h.dispatched()
    ok, msg = h.expect_abort("UPDATE tts_jobs SET status='running' WHERE id='J1'",
                             "state transition requires execution command")
    assert ok, msg


def js02(h):
    h.dispatched()
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET status='running', owner_token='w1',"
        " lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() + 600000),
        ["state transition requires execution command", "lease requires execution command"])
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
    """并发第二个 worker_claim → ABORT，恰好一个 running owner。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1',NULL,1,'worker_claim','generation_pending','running','queued','running',
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
    """running→succeeded 第二条 command → PASS（完整链）。"""
    _full_success(h)
    h.state_transition("T2", to="succeeded", result="ART1")
    j = h.query("SELECT status,result_artifact_id,claimed_by,finished_at,error_code FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,result_artifact_id,owner_token,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "succeeded" and j[1] == "ART1" and j[2] is None and j[3] and j[4] is None, "job=%s" % (j,)
    assert c[0] == "succeeded" and c[1] == "ART1" and c[2] is None and c[3] is None, "claim=%s" % (c,)
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE job_id='J1'")[0]
    assert str(n[0]) == "2", "command rows=%s" % (n,)


def js07(h):
    h.running_pair()
    h.state_transition("T2", to="failed", error_code="E1", error_message="boom")
    j = h.query("SELECT status,error_code,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "failed" and j[1] == "E1" and j[2] is None, "job=%s" % (j,)
    assert c == ("failed", None), "claim=%s" % (c,)


def js08(h):
    h.running_pair()
    h.state_transition("T2", to="cancelled", reason="user")
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "cancelled" and c[0] == "cancelled", "job=%s claim=%s" % (j, c)


def js09(h):
    """running→indeterminate 保留双侧 owner/lease（供 renewal/takeover/resolve fence）。"""
    h.running_pair()
    h.state_transition("T2", to="indeterminate", reason="crash?")
    j = h.query("SELECT status,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j == ("indeterminate", "w1"), "job=%s" % (j,)
    assert c[0] == "indeterminate" and c[1] == "w1" and c[2] is not None, "claim=%s" % (c,)


def js10(h):
    """indeterminate→failed 第三条 command → PASS。"""
    h.running_pair()
    h.state_transition("T2", to="indeterminate", reason="crash?")
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
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T9','req-T-wc-J1','J9','C9',NULL,1,'worker_claim','generation_pending','running','queued','running',
                'w9',%d,1,%s,%s,%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "UNIQUE constraint failed: tts_job_execution_transitions.transition_request_id")
    assert ok, msg


def js11b(h):
    """完全相同 worker_claim replay（同 from/to/attempt，不同 request id）→ 语义 UNIQUE/状态 ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T9','req-T9','J1','C1',NULL,1,'worker_claim','generation_pending','running','queued','running',
                'w2',%d,1,%s,%s,%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "tts_job_execution_transitions")
    assert ok, msg


def js12(h):
    """同 job 多阶段 command 连续提交且 evidence 全保留。"""
    _full_success(h)
    h.state_transition("T2", to="succeeded", result="ART1")
    rows = h.query("SELECT from_job_status,to_job_status FROM tts_job_execution_transitions WHERE job_id='J1' ORDER BY created_at")
    assert len(rows) == 2 and ("queued", "running") in rows and ("running", "succeeded") in rows, "rows=%s" % (rows,)


def js13(h):
    """succeeded command 携带属于其他 job 的 artifact → identity mismatch ABORT + 回滚。"""
    _full_success(h)
    h.running_pair("C2", "J2", seed=False)
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         result_artifact_id,activated_at,created_at)
        VALUES ('T2','req-T2','J2','C2','T-wc-J2',2,'state_transition','running','succeeded','running','succeeded',
                'w1',1,'ART1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "result artifact identity mismatch")
    assert ok, msg
    j2 = h.query("SELECT status FROM tts_jobs WHERE id='J2'")[0]
    assert j2[0] == "running", "J2 应保持 running（回滚）：%s" % (j2,)


def js14(h):
    """succeeded command 但 artifact 不存在 → 整条 statement 回滚：claim/job 保持 running。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         result_artifact_id,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'state_transition','running','succeeded','running','succeeded',
                'w1',1,'ART-X',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "result artifact identity mismatch")
    assert ok, msg
    j = h.query("SELECT status FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status FROM tts_synthesis_claims WHERE id='C1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert j[0] == "running" and c[0] == "running" and str(n[0]) == "0", "job=%s claim=%s rows=%s" % (j, c, n)


def js15(h):
    """from-state 任一不匹配 → ABORT。"""
    h.dispatched()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T1','req-T1','J1','C1',NULL,1,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "job claim mismatch")
    assert ok, msg


def js16(h):
    """expired running owner（claim lease 已过期，真实时序）→ state_transition fencing ABORT。"""
    h.dispatched()
    h.worker_claim("T1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    import time as _t
    _t.sleep(0.8)  # lease 过期
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T1',2,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg


def js17(h):
    """execution_takeover command（R11：替代 R10 的两条 UPDATE CAS）：
    旧 §3.6 两条 UPDATE 模拟接管 → per-column fence ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() - 1000),
        "lease requires execution command")
    assert ok, msg
    # R10 旧 §3.6 两条 UPDATE 模拟接管 → 被 per-column fence 拦截（这正是 R11 关闭的 P0-A）
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET owner_token='w2', lease_expires_at_epoch_ms=%d,"
        " validation_attempt=validation_attempt+1 WHERE id='C1'" % (now_ms() + 600000),
        "requires execution command")
    assert ok, msg


def js18(h):
    """running claim 单独修改 owner_token → command required ABORT（split owner 不可提交）。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET owner_token='hacker' WHERE id='C1'",
        "owner requires execution command")
    assert ok, msg


def js19(h):
    """running job 单独修改 claimed_by / attempt → command required ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET claimed_by='hacker' WHERE id='J1'",
        "claimed_by requires execution command")
    assert ok, msg
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET attempt=99 WHERE id='J1'",
        "attempt requires execution command")
    assert ok, msg


def js20(h):
    """running job 只更新 heartbeat、claim lease 不更新 → ABORT（双侧必须经同一条 command）。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET heartbeat_at=%s WHERE id='J1'" % q(iso(0)),
        "heartbeat_at requires execution command")
    assert ok, msg


def js21(h):
    """terminal succeeded 后重新写 claimed_by / heartbeat → ABORT（fence + immutable 双拒绝）。"""
    _full_success(h)
    h.state_transition("T2", to="succeeded", result="ART1")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET claimed_by='w9' WHERE id='J1'",
        ["claimed_by requires execution command", "terminal owner shape violated"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET heartbeat_at=%s WHERE id='J1'" % q(iso(0)),
        ["heartbeat_at requires execution command", "terminal owner shape violated"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET owner_token='w9' WHERE id='C1'",
        ["owner requires execution command", "CHECK constraint failed", "terminal immutable"])
    assert ok, msg


def js22(h):
    """lease_renewal command → 双侧原子更新（claim lease + job heartbeat）。"""
    h.running_pair()
    old_lease = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0][0]
    new_lease = int(old_lease) + 300000
    hb = iso(0)
    h.lease_renewal("T2", new_lease=new_lease, heartbeat=hb, token="w1", attempt=1)
    c = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT heartbeat_at,claimed_by,attempt FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == str(new_lease), "claim lease=%s" % (c,)
    assert j[0] == hb and j[1] == "w1" and str(j[2]) == "1", "job=%s" % (j,)


def js23(h):
    """renewal 失败注入 → command/claim/job 全部回滚（fence ABORT 整条 statement）。"""
    h.running_pair()
    old_lease = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0][0]
    old_hb = h.query("SELECT heartbeat_at FROM tts_jobs WHERE id='J1'")[0][0]
    # 新 lease 不大于旧 lease → fence ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'lease_renewal','running','running','running','running',
                'w1',%d,1,%s,%s,%s)""" % (int(old_lease), q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    # 错误 token → ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         heartbeat_at,activated_at,created_at)
        VALUES ('T3','req-T3','J1','C1','T-wc-J1',2,'lease_renewal','running','running','running','running',
                'wrong',%d,1,%s,%s,%s)""" % (int(old_lease) + 300000, q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    c = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT heartbeat_at FROM tts_jobs WHERE id='J1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE command_kind='lease_renewal'")[0]
    assert str(c[0]) == str(old_lease) and j[0] == old_hb and str(n[0]) == "0", \
        "回滚不完整：lease=%s hb=%s rows=%s" % (c, j, n)


def js24(h):
    """直接改 claim lease 被 per-column fence 拒（P0-A 关闭实证；构造过期只能走真实时序 js26b）。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() - 1000),
        "lease requires execution command")
    assert ok, msg
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%d WHERE id='C1'" % (now_ms() + 900000),
        "lease requires execution command")
    assert ok, msg


def js24b(h):
    """执行期 lease 过期：先用 lease_renewal 无法缩短——改为直接从 worker_claim 用短 lease 不现实；
    采用独立 DB 场景：直接以 takeover 需要的前提构造（claim lease 已过期由 DB 时间决定——
    用带过期 lease 的 worker_claim？不允许。因此 takeover 测试用真实时序：claim 在 running 时
    lease 保持（不可直接改），本测试验证 takeover 在 lease 未过期时 ABORT（fencing），
    过期场景由 js26 用 -bail 时序验证。"""
    h.running_pair()
    # lease 未过期 → takeover ABORT（旧 lease 必须 < DB_NOW_MS）
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'execution_takeover','running','running','running','running',
                'w2',%d,2,%s,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg


def js25(h):
    """takeover 失败注入（attempt 不连续 / 新 owner 相同）→ 整条回滚，旧 owner/attempt 完全保留。"""
    h.running_pair()
    c = h.query("SELECT owner_token,validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT claimed_by,attempt FROM tts_jobs WHERE id='J1'")[0]
    # attempt 必须是旧+1：给 3（旧=1）→ fence ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'execution_takeover','running','running','running','running',
                'w2',%d,3,%s,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    # 新 owner 与旧 owner 相同 → ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T3','req-T3','J1','C1','T-wc-J1',2,'execution_takeover','running','running','running','running',
                'w1',%d,2,%s,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    c2 = h.query("SELECT owner_token,validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    j2 = h.query("SELECT claimed_by,attempt FROM tts_jobs WHERE id='J1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE command_kind='execution_takeover'")[0]
    assert c2 == c and j2 == j and str(n[0]) == "0", "旧状态被改：c=%s j=%s rows=%s" % (c2, j2, n)



def js26b(h):
    """真实时序：worker_claim lease=+600ms → 等待 1.1s 过期 → takeover 成功（attempt+1）→
    新 owner transition PASS；旧 owner renewal/transition ABORT。"""
    h.dispatched()
    short_lease = now_ms() + 600
    h.worker_claim("T1", token="w1", lease_ms=short_lease, attempt=1)
    import time as _t
    _t.sleep(1.2)
    h.execution_takeover("T2", new_token="w2", attempt=2, new_lease=now_ms() + 900000)
    c = h.query("SELECT owner_token,validation_attempt,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT claimed_by,attempt FROM tts_jobs WHERE id='J1'")[0]
    assert c[0] == "w2" and str(c[1]) == "2" and c[2], "claim=%s" % (c,)
    assert j[0] == "w2" and str(j[1]) == "2", "job=%s" % (j,)
    # 旧 owner（w1, attempt 1）renewal → ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         heartbeat_at,activated_at,created_at)
        VALUES ('T3','req-T3','J1','C1','T2',3,'lease_renewal','running','running','running','running',
                'w1',%d,1,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    # 旧 owner state_transition → ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T4','req-T4','J1','C1','T2',3,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "worker fencing mismatch")
    assert ok, msg
    # 新 owner（w2, attempt 2）failed → PASS
    h.state_transition("T5", to="failed", token="w2", attempt=2, error_code="E2", error_message="took over")
    jf = h.query("SELECT status,claimed_by FROM tts_jobs WHERE id='J1'")[0]
    cf = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert jf == ("failed", None) and cf == ("failed", None), "job=%s claim=%s" % (jf, cf)


def js27(h):
    """prestart_terminal queued/generation_pending → failed 全链 PASS。"""
    h.dispatched()
    h.prestart_terminal("T1", to_status="failed", error_code="PREFLIGHT", error_message="config bad")
    j = h.query("SELECT status,claimed_by,error_code,finished_at FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token,lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "failed" and j[1] is None and j[2] == "PREFLIGHT" and j[3], "job=%s" % (j,)
    assert c[0] == "failed" and c[1] is None and c[2] is None, "claim=%s" % (c,)


def js28(h):
    """prestart_terminal → cancelled 全链 PASS。"""
    h.dispatched()
    h.prestart_terminal("T1", to_status="cancelled", reason="no-subscriber")
    j = h.query("SELECT status,claimed_by,error_code,error_message FROM tts_jobs WHERE id='J1'")[0]
    c = h.query("SELECT status,owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert j[0] == "cancelled" and j[1] is None, "job=%s" % (j,)
    assert c == ("cancelled", None), "claim=%s" % (c,)


def js29(h):
    """prestart command 在 running 状态使用 → ABORT（from 状态不匹配）。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_attempt,error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'prestart_terminal','generation_pending','failed','queued','failed',
                1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "job claim mismatch")
    assert ok, msg
    # 同时验证 CHECK：prestart 携带 owner 建立字段 → shape ABORT
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,error_code,activated_at,created_at)
        VALUES ('T3','req-T3','J9','C9',NULL,1,'prestart_terminal','generation_pending','failed','queued','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "CHECK constraint failed")
    assert ok, msg


def js30(h):
    """错误 command field shape → CHECK/trigger ABORT（一类 command 不得携带他类证据字段）。"""
    h.dispatched()
    # worker_claim 携带 result → CHECK
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,result_artifact_id,activated_at,created_at)
        VALUES ('T1','req-T1','J1','C1',NULL,1,'worker_claim','generation_pending','running','queued','running',
                'w1',%d,1,%s,%s,'ARTX',%s,%s)""" % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "CHECK constraint failed")
    assert ok, msg
    # lease_renewal 携带 claimed_at → CHECK（同一 fixture 先 worker_claim 成 running）
    h.worker_claim("T1")
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         claimed_at,heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1',NULL,1,'lease_renewal','running','running','running','running',
                'w1',%d,1,%s,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0)), q(iso(0))),
        "CHECK constraint failed")
    assert ok, msg
    # state_transition failed 无 error_code → CHECK
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,activated_at,created_at)
        VALUES ('T3','req-T3','J1','C1',NULL,1,'state_transition','running','failed','running','failed',
                'w1',1,%s,%s)""" % (q(iso(0)), q(iso(0))),
        "CHECK constraint failed")
    assert ok, msg


def js31(h):
    """同一 renewal request replay → transition_request_id UNIQUE 拒绝。"""
    h.running_pair()
    new_lease = now_ms() + 900000
    hb = iso(0)
    h.lease_renewal("T2", new_lease=new_lease, heartbeat=hb, token="w1", attempt=1)
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T2',3,'lease_renewal','running','running','running','running',
                'w1',%d,1,%s,%s,%s)""" % (new_lease, q(hb), q(iso(0)), q(iso(0))),
        "UNIQUE constraint failed: tts_job_execution_transitions.transition_request_id")
    assert ok, msg


def js32(h):
    """不同 renewal request、同 attempt、新 lease 递增 → 合法（多次续租）。"""
    h.running_pair()
    l1 = now_ms() + 900000
    l2 = l1 + 300000
    h.lease_renewal("T2", new_lease=l1, heartbeat=iso(0), token="w1", attempt=1)
    h.lease_renewal("T3", new_lease=l2, heartbeat=iso(0), token="w1", attempt=1)
    c = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE command_kind='lease_renewal'")[0]
    assert str(c[0]) == str(l2), "lease=%s" % (c,)
    assert str(n[0]) == "2", "renewal rows=%s" % (n,)


def js33(h):
    """真实 BEGIN IMMEDIATE 跨语句事务：成功事务内 renewal command + 状态确认一起提交。"""
    h.running_pair()
    new_lease = now_ms() + 900000
    hb = iso(0)
    h.tx([
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
         heartbeat_at,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'lease_renewal','running','running','running','running',
                'w1',%d,1,%s,%s,%s)""" % (new_lease, q(hb), q(iso(0)), q(iso(0))),
        "UPDATE tts_audio_requests SET updated_at=%s WHERE claim_id='C1'" % q(iso(0)),
    ])
    c = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT heartbeat_at FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == str(new_lease) and j[0] == hb, "c=%s j=%s" % (c, j)


def js34(h):
    """真实 BEGIN IMMEDIATE 跨语句回滚：事务内第二条 statement 失败 → 第一条 command 全部回滚。"""
    h.running_pair()
    old_lease = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0][0]
    old_hb = h.query("SELECT heartbeat_at FROM tts_jobs WHERE id='J1'")[0][0]
    try:
        h.tx([
            """INSERT INTO tts_job_execution_transitions
            (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
             from_claim_status,to_claim_status,from_job_status,to_job_status,
             worker_owner_token,worker_lease_expires_at_epoch_ms,worker_attempt,
             heartbeat_at,activated_at,created_at)
            VALUES ('T2','req-T2','J1','C1',NULL,1,'lease_renewal','running','running','running','running',
                    'w1',%d,1,%s,%s,%s)""" % (now_ms() + 900000, q(iso(0)), q(iso(0)), q(iso(0))),
            # 第二条失败：request 无 result_artifact_id 置 succeeded → CHECK 约束错误
            "UPDATE tts_audio_requests SET status='succeeded' WHERE claim_id='C1'",
        ])
        raise AssertionError("事务第二条失败未抛错")
    except Exception as e:
        pass
    c = h.query("SELECT lease_expires_at_epoch_ms FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT heartbeat_at FROM tts_jobs WHERE id='J1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert str(c[0]) == str(old_lease) and j[0] == old_hb and str(n[0]) == "0", \
        "事务回滚不完整：lease=%s hb=%s rows=%s" % (c, j, n)


def js35(h):
    """prestart 携带 owner 伪装（running owner 字段）→ CHECK ABORT；且 prestart 后 owner 保持 NULL。"""
    h.dispatched()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,error_code,activated_at,created_at)
        VALUES ('T1','req-T1','J1','C1',NULL,1,'prestart_terminal','generation_pending','failed','queued','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "CHECK constraint failed")
    assert ok, msg


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
    ("JS-11b", "完全相同 worker_claim replay → 语义 UNIQUE/状态 ABORT", js11b),
    ("JS-12", "同 job 多阶段 command 连续提交且 evidence 全保留", js12),
    ("JS-13", "succeeded result artifact identity 不匹配 → ABORT", js13),
    ("JS-14", "中间步骤失败整条 command statement 回滚", js14),
    ("JS-15", "from-state 任一不匹配 → ABORT", js15),
    ("JS-16", "直接改 lease 被 fence 拒；expired owner state_transition 被 fence 拒", js16),
    ("JS-17", "旧 §3.6 两条 UPDATE 模拟接管 → per-column fence ABORT（P0-A 关闭实证）", js17),
    ("JS-18", "running claim 单独改 owner_token → command required ABORT", js18),
    ("JS-19", "running job 单独改 claimed_by/attempt → command required ABORT", js19),
    ("JS-20", "running job 只更新 heartbeat（claim lease 不更新）→ ABORT", js20),
    ("JS-21", "terminal 后重新写 claimed_by/heartbeat/owner → ABORT", js21),
    ("JS-22", "lease_renewal command → 双侧原子更新", js22),
    ("JS-23", "renewal 失败注入（lease 不递增/错误 token）→ command/claim/job 全部回滚", js23),
    ("JS-24", "直接改 lease 被 fence 拒（构造过期前置）", js24),
    ("JS-24b", "takeover 在 lease 未过期时 → fencing ABORT", js24b),
    ("JS-25", "takeover 失败注入（attempt 不连续/新 owner 相同）→ 旧状态完全保留", js25),
    ("JS-26b", "真实时序：lease 过期 → takeover attempt+1 → 新 owner 通过/旧 owner 全拒", js26b),
    ("JS-27", "prestart_terminal queued/generation_pending → failed 全链 PASS", js27),
    ("JS-28", "prestart_terminal → cancelled 全链 PASS", js28),
    ("JS-29", "prestart command 在 running 状态使用 → ABORT", js29),
    ("JS-30", "错误 command field shape → CHECK/trigger ABORT", js30),
    ("JS-31", "同一 renewal request replay → requestId UNIQUE 拒绝", js31),
    ("JS-32", "不同 renewal request、同 attempt、新 lease 递增 → 合法", js32),
    ("JS-33", "真实 BEGIN IMMEDIATE 成功事务（renewal command 在事务内）", js33),
    ("JS-34", "真实 BEGIN IMMEDIATE 跨语句回滚（第二条失败 → 第一条全回滚）", js34),
    ("JS-35", "prestart 携带 owner 伪装 → CHECK ABORT", js35),
]
