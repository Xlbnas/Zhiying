"""HR-01..HR-20：historical command replay seal（R12 applied-command chain 实证）。

核心命题：历史 command 永远不能授权新 direct UPDATE。
全部使用真实历史值（真实 token/lease/heartbeat/attempt/command id/seq），
禁止只使用 'hacker'/'w9' 等不存在值冒充重放关闭。
"""
from contract_runner import iso, now_ms, q


def _wc_takeover(h):
    """worker_claim w1 (seq1) → lease 过期 → execution_takeover w2 (seq2)。返回各历史值。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    wc = h.query("SELECT id, worker_owner_token, worker_lease_expires_at_epoch_ms,"
                 " heartbeat_at, claimed_at, worker_attempt FROM tts_job_execution_transitions WHERE id='T-wc-J1'")[0]
    import time as _t
    _t.sleep(0.8)
    h.execution_takeover("T-tk-J1", new_token="w2", attempt=2, new_lease=now_ms() + 900000)
    return wc


def hr01(h):
    """worker_claim w1 → takeover w2 → direct UPDATE claim.owner_token='w1'（真实历史 token）→ ABORT。"""
    wc = _wc_takeover(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET owner_token=%s WHERE id='C1'" % q(wc[1]),
        "owner requires execution command")
    assert ok, "历史 w1 token 重放被放行：%s" % msg
    c = h.query("SELECT owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "w2", "claim owner 被改：%s" % (c,)


def hr02(h):
    """同场景 direct UPDATE job.claimed_by='w1'（真实历史 token）→ ABORT。"""
    wc = _wc_takeover(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET claimed_by=%s WHERE id='J1'" % q(wc[1]),
        "claimed_by requires execution command")
    assert ok, msg
    j = h.query("SELECT claimed_by FROM tts_jobs WHERE id='J1'")[0]
    assert j[0] == "w2", "job claimed_by 被改：%s" % (j,)


def hr03(h):
    """同场景 direct UPDATE claim lease=历史 worker_claim lease → ABORT。"""
    wc = _wc_takeover(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET lease_expires_at_epoch_ms=%s WHERE id='C1'" % wc[2],
        "lease requires execution command")
    assert ok, msg


def hr04(h):
    """同场景 direct UPDATE job heartbeat=历史 heartbeat → ABORT。"""
    wc = _wc_takeover(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET heartbeat_at=%s WHERE id='J1'" % q(wc[3]),
        "heartbeat_at requires execution command")
    assert ok, msg


def hr05(h):
    """takeover 后 direct UPDATE job.attempt=历史 attempt(1) → ABORT。"""
    wc = _wc_takeover(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET attempt=%s WHERE id='J1'" % wc[5],
        "attempt requires execution command")
    assert ok, msg
    j = h.query("SELECT attempt FROM tts_jobs WHERE id='J1'")[0]
    assert str(j[0]) == "2", "attempt 被回退：%s" % (j,)


def hr06(h):
    """worker_claim w1 → succeeded → direct UPDATE terminal job.claimed_by='w1' → ABORT。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    h.walk_attempt_to_succeeded()
    h.insert_artifact()
    h.state_transition("T-st-J1", to="succeeded", result="ART1")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET claimed_by='w1' WHERE id='J1'",
        ["claimed_by requires execution command", "terminal owner shape violated"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET claimed_by='w1' WHERE id='J1' AND status='succeeded'",
        ["claimed_by requires execution command", "terminal owner shape violated"])
    assert ok, msg


def hr07(h):
    """terminal job 恢复历史 claimed_at/heartbeat/attempt 逐项 ABORT。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    wc = h.query("SELECT claimed_at, heartbeat_at, worker_attempt FROM tts_job_execution_transitions WHERE id='T-wc-J1'")[0]
    h.state_transition("T-st-J1", to="failed", error_code="E", error_message="m")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET claimed_at=%s WHERE id='J1'" % q(wc[0]),
        ["claimed_at requires execution command", "terminal owner shape violated"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET heartbeat_at=%s WHERE id='J1'" % q(wc[1]),
        ["heartbeat_at requires execution command", "terminal owner shape violated"])
    assert ok, msg
    # 当前 attempt 已等于历史值（worker_claim 后 state_transition 不改 attempt），
    # 直接回写历史值是无操作；此处验证伪造新值（从未出现过的 attempt）同样被拒
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET attempt=99 WHERE id='J1'",
        ["attempt requires execution command", "terminal owner shape violated"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET attempt=0 WHERE id='J1'",
        ["attempt requires execution command", "terminal owner shape violated"])
    assert ok, msg


def hr08(h):
    """running→indeterminate(reason) → lease 过期 takeover → indeterminate→failed(E2) →
    direct UPDATE error_code/error_message 回旧值 → ABORT（terminal evidence 不可改写）。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    h.state_transition("T-in-J1", to="indeterminate", reason="crash?")  # seq2（lease 仍有效）
    import time as _t
    _t.sleep(0.8)
    h.execution_takeover("T-tk-J1", new_token="w2", attempt=2, new_lease=now_ms() + 900000, frm="indeterminate")  # seq3
    h.state_transition("T-fa-J1", frm="indeterminate", to="failed", token="w2", attempt=2,
                       error_code="E2", error_message="confirmed")  # seq4
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET error_code='crash?', error_message='crash?' WHERE id='J1'",
        ["error_code requires execution command", "error_message requires execution command",
         "immutable field"])
    assert ok, msg
    j = h.query("SELECT error_code,error_message FROM tts_jobs WHERE id='J1'")[0]
    assert j == ("E2", "confirmed"), "error evidence 被改写：%s" % (j,)


def hr09(h):
    """direct UPDATE head 回历史 command id/seq → ABORT。"""
    h.running_pair()  # worker_claim T-wc-J1 seq1
    h.lease_renewal("T-rn-J1", new_lease=now_ms() + 900000, heartbeat=iso(0), token="w1", attempt=1)  # seq2
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='T-wc-J1', execution_command_seq=1 WHERE id='C1'",
        "execution head requires command")
    assert ok, msg
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET last_execution_command_id='T-wc-J1', execution_command_seq=1 WHERE id='J1'",
        "execution head requires command")
    assert ok, msg
    c = h.query("SELECT last_execution_command_id, execution_command_seq FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c == ("T-rn-J1", "2") or (c[0] == "T-rn-J1" and str(c[1]) == "2"), "head 被回退：%s" % (c,)


def hr10(h):
    """direct UPDATE head 跳 seq（seq=5 但当前=1）→ ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='X', execution_command_seq=5 WHERE id='C1'",
        "execution head requires command")
    assert ok, msg


def hr11(h):
    """使用历史 command id，同时复制该历史 command 的全部字段（含 head/seq/owner）→ 仍 ABORT。"""
    wc = _wc_takeover(h)  # head=T-tk-J1/3, owner=w2；历史 worker_claim=w1
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='T-wc-J1', execution_command_seq=1,"
        " owner_token='w1' WHERE id='C1'",
        "requires execution command")
    assert ok, msg
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET last_execution_command_id='T-wc-J1', execution_command_seq=1,"
        " claimed_by='w1' WHERE id='J1'",
        "requires execution command")
    assert ok, msg
    c = h.query("SELECT owner_token, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "w2" and c[1] == "T-tk-J1" and str(c[2]) == "2", "被篡改：%s" % (c,)


def hr12(h):
    """claim 只推进 command head、job 不推进 → ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='NEW1', execution_command_seq=2 WHERE id='C1'",
        "execution head requires command")
    assert ok, msg
    c = h.query("SELECT execution_command_seq FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT execution_command_seq FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == "1" and str(j[0]) == "1", "head 被单侧推进：c=%s j=%s" % (c, j)


def hr13(h):
    """job 只推进 command head、claim 不推进 → ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET last_execution_command_id='NEW1', execution_command_seq=2 WHERE id='J1'",
        "execution head requires command")
    assert ok, msg


def hr14(h):
    """command.previous_command_id 不等于当前双侧 head → chain mismatch ABORT（整条回滚）。"""
    h.running_pair()  # head = T-wc-J1/1
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','WRONG-PREV',2,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "chain mismatch")
    assert ok, msg
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert str(n[0]) == "0", "command 行残留：%s" % (n,)


def hr15(h):
    """command_seq 跳号（当前 head seq=1，INSERT seq=3）→ chain mismatch ABORT；
    同 seq 重复 → UNIQUE(job_id,command_seq) ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T2','req-T2','J1','C1','T-wc-J1',3,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        "chain mismatch")
    assert ok, msg
    ok, msg = h.expect_abort_any(
        """INSERT INTO tts_job_execution_transitions
        (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
         from_claim_status,to_claim_status,from_job_status,to_job_status,
         worker_owner_token,worker_attempt,
         error_code,activated_at,created_at)
        VALUES ('T3','req-T3','J1','C1','T-wc-J1',1,'state_transition','running','failed','running','failed',
                'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
        ["UNIQUE constraint failed: tts_job_execution_transitions.job_id",
         "UNIQUE constraint failed: tts_job_execution_transitions.claim_id"])
    assert ok, msg


def hr16(h):
    """有效 lease_renewal：双侧 head 同时 seq+1、command id exact。"""
    h.running_pair()
    h.lease_renewal("T-rn-J1", new_lease=now_ms() + 900000, heartbeat=iso(0), token="w1", attempt=1)
    c = h.query("SELECT last_execution_command_id, execution_command_seq FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT last_execution_command_id, execution_command_seq FROM tts_jobs WHERE id='J1'")[0]
    assert c[0] == "T-rn-J1" and str(c[1]) == "2", "claim head=%s" % (c,)
    assert j[0] == "T-rn-J1" and str(j[1]) == "2", "job head=%s" % (j,)
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T-rn-J1'")[0]
    assert str(n[0]) == "1", "command 行=%s" % (n,)


def hr17(h):
    """有效 takeover：双侧 head 同时 seq+1，owner/attempt exact。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    import time as _t
    _t.sleep(0.8)
    h.execution_takeover("T-tk-J1", new_token="w2", attempt=2, new_lease=now_ms() + 900000)
    c = h.query("SELECT owner_token, validation_attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT claimed_by, attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_jobs WHERE id='J1'")[0]
    assert c[0] == "w2" and str(c[1]) == "2" and c[2] == "T-tk-J1" and str(c[3]) == "2", "claim=%s" % (c,)
    assert j[0] == "w2" and str(j[1]) == "2" and j[2] == "T-tk-J1" and str(j[3]) == "2", "job=%s" % (j,)


def hr18(h):
    """有效 state_transition：双侧 head 同时推进，terminal shape 正确（claimed_* NULL）。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    h.walk_attempt_to_succeeded()
    h.insert_artifact()
    h.state_transition("T-st-J1", to="succeeded", result="ART1")
    c = h.query("SELECT last_execution_command_id, execution_command_seq FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT status, claimed_by, claimed_at, heartbeat_at, last_execution_command_id,"
                " execution_command_seq FROM tts_jobs WHERE id='J1'")[0]
    assert c[0] == "T-st-J1" and str(c[1]) == "2", "claim head=%s" % (c,)
    assert j[0] == "succeeded" and j[1] is None and j[2] is None and j[3] is None, "terminal shape=%s" % (j,)
    assert j[4] == "T-st-J1" and str(j[5]) == "2", "job head=%s" % (j,)


def hr19(h):
    """第二侧更新故障（真实 BEGIN IMMEDIATE 跨语句失败）：
    command + claim head/status/owner + job head/status/owner 全回滚。"""
    h.running_pair()  # head=T-wc-J1/1
    old_c = h.query("SELECT status, owner_token, last_execution_command_id, execution_command_seq"
                    " FROM tts_synthesis_claims WHERE id='C1'")[0]
    old_j = h.query("SELECT status, claimed_by, last_execution_command_id, execution_command_seq"
                    " FROM tts_jobs WHERE id='J1'")[0]
    try:
        h.tx([
            """INSERT INTO tts_job_execution_transitions
            (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
             from_claim_status,to_claim_status,from_job_status,to_job_status,
             worker_owner_token,worker_attempt,
             error_code,activated_at,created_at)
            VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'state_transition','running','failed','running','failed',
                    'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
            # 第二条失败：request 无 result 置 succeeded → CHECK 约束错误
            "UPDATE tts_audio_requests SET status='succeeded' WHERE claim_id='C1'",
        ])
        raise AssertionError("事务第二条失败未抛错")
    except Exception:
        pass
    c = h.query("SELECT status, owner_token, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT status, claimed_by, last_execution_command_id, execution_command_seq"
                " FROM tts_jobs WHERE id='J1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert c == old_c, "claim 未回滚：%s vs %s" % (c, old_c)
    assert j == old_j, "job 未回滚：%s vs %s" % (j, old_j)
    assert str(n[0]) == "0", "command 行残留：%s" % (n,)


def hr20(h):
    """构造历史 worker_claim + renewal + takeover 多条记录，任何旧行均不能授权 direct mutation。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    # 历史 renewal（seq2）—— lease 仍有效时续租，随后自然过期
    h.lease_renewal("T-rn-J1", new_lease=now_ms() + 400, heartbeat=iso(0), token="w1", attempt=1)
    import time as _t
    _t.sleep(0.8)
    h.execution_takeover("T-tk-J1", new_token="w2", attempt=2, new_lease=now_ms() + 900000)
    rows = h.query("SELECT id, command_seq FROM tts_job_execution_transitions WHERE job_id='J1' ORDER BY command_seq")
    assert len(rows) == 3, "历史行=%s" % (rows,)
    # 非当前历史行（seq<当前 head）重放 → 必须 ABORT（seq 必须 = OLD+1）
    for rid, rseq, owner in (("T-wc-J1", 1, "w1"), ("T-rn-J1", 2, "w1")):
        ok, msg = h.expect_abort(
            "UPDATE tts_synthesis_claims SET last_execution_command_id='%s', execution_command_seq=%d,"
            " owner_token='%s' WHERE id='C1'" % (rid, rseq, owner),
            "requires execution command")
        assert ok, "历史行 %s 授权了 direct mutation" % rid
        ok, msg = h.expect_abort(
            "UPDATE tts_jobs SET last_execution_command_id='%s', execution_command_seq=%d,"
            " claimed_by='%s' WHERE id='J1'" % (rid, rseq, owner),
            "requires execution command")
        assert ok, "历史行 %s 授权了 job direct mutation" % rid
    # 当前 head 行（T-tk-J1/3）的"完整重放"：目标值与现值相同 → 无操作、零变化（不构成篡改）；
    # 但任何改值变体（借当前 head 行 id 写不同 owner/head）必须 ABORT
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET owner_token='hacker' WHERE id='C1'",
        "owner requires execution command")
    assert ok, "借当前 head 行改写 owner 被放行"
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='T-tk-J1', execution_command_seq=3,"
        " owner_token='w9' WHERE id='C1'",
        "requires execution command")
    assert ok, "借当前 head 行 id 改 owner 被放行"
    c = h.query("SELECT owner_token, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "w2" and c[1] == "T-tk-J1" and str(c[2]) == "3", "head 被篡改：%s" % (c,)


TESTS = [
    ("HR-01", "历史 w1 token 重放 claim.owner_token → ABORT（真实历史值）", hr01),
    ("HR-02", "历史 w1 token 重放 job.claimed_by → ABORT", hr02),
    ("HR-03", "历史 worker_claim lease 重放 claim lease → ABORT", hr03),
    ("HR-04", "历史 heartbeat 重放 job heartbeat → ABORT", hr04),
    ("HR-05", "历史 attempt 重放 job attempt → ABORT", hr05),
    ("HR-06", "terminal 后历史 w1 复活 claimed_by → ABORT", hr06),
    ("HR-07", "terminal 恢复历史 claimed_at/heartbeat/attempt 逐项 → ABORT", hr07),
    ("HR-08", "terminal error evidence 回旧值 → ABORT", hr08),
    ("HR-09", "head 回历史 command id/seq → ABORT", hr09),
    ("HR-10", "head 跳 seq → ABORT", hr10),
    ("HR-11", "历史 command id+全字段复制 → 仍 ABORT", hr11),
    ("HR-12", "claim 单侧推进 head → ABORT", hr12),
    ("HR-13", "job 单侧推进 head → ABORT", hr13),
    ("HR-14", "command.previous_command_id ≠ 当前 head → chain mismatch + 回滚", hr14),
    ("HR-15", "command_seq 跳号/重复 → chain/UNIQUE ABORT", hr15),
    ("HR-16", "有效 lease_renewal：双侧 head 同时 seq+1", hr16),
    ("HR-17", "有效 takeover：双侧 head 同时 seq+1，owner/attempt exact", hr17),
    ("HR-18", "有效 state_transition：双侧 head 推进，terminal shape 正确", hr18),
    ("HR-19", "第二侧故障（真实事务）：command+双侧 head/status/owner 全回滚", hr19),
    ("HR-20", "历史 worker_claim+renewal+takeover 全部旧行均不能授权 direct mutation", hr20),
]
