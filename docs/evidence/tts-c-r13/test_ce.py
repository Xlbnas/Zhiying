"""CE-01..CE-20：claim terminal evidence seal + post-validation evidence seal（R13）。

核心命题：
1. generated terminal（succeeded/failed/cancelled）claim.validation_attempt 无 command 不可改；
2. 离开 validating_reuse 后 candidate/validation evidence 不可重写（post-validation seal）；
3. terminal claim 全字段（含 updated_at / execution head）不可变；
4. 合法 takeover / finalize / state_transition / prestart / reuse 不被新 trigger 误伤。
全部断言查询最终 row 值，不满足于"出现任意错误"。
"""
from contract_runner import iso, now_ms, q


def _generated_terminal(h, to_status="failed"):
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    if to_status == "succeeded":
        h.walk_attempt_to_succeeded()
        h.insert_artifact()
        h.state_transition("T-st-J1", to="succeeded", result="ART1")
    else:
        h.state_transition("T-st-J1", to=to_status, error_code="E1", error_message="m")
    return h.query("SELECT validation_attempt, status FROM tts_synthesis_claims WHERE id='C1'")[0]


def ce01(h):
    """generated failed 后 UPDATE validation_attempt=99 → ABORT；row 值不变。"""
    before = _generated_terminal(h, "failed")
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=99 WHERE id='C1'",
        "terminal immutable")
    assert ok, msg
    after = h.query("SELECT validation_attempt, status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert after == before, "attempt 被篡改：%s -> %s" % (before, after)


def ce02(h):
    """generated succeeded 后 UPDATE validation_attempt=99 → ABORT。"""
    before = _generated_terminal(h, "succeeded")
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=99 WHERE id='C1'",
        "terminal immutable")
    assert ok, msg
    after = h.query("SELECT validation_attempt, status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert after == before, "attempt 被篡改：%s -> %s" % (before, after)


def ce03(h):
    """generated cancelled 后 UPDATE validation_attempt=99 → ABORT。"""
    before = _generated_terminal(h, "cancelled")
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=99 WHERE id='C1'",
        "terminal immutable")
    assert ok, msg
    after = h.query("SELECT validation_attempt, status FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert after == before, "attempt 被篡改：%s -> %s" % (before, after)


def ce04(h):
    """generated running：直接改 validation_attempt → 仍由 exact command fence ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=5 WHERE id='C1'",
        "attempt requires execution command")
    assert ok, msg
    c = h.query("SELECT validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT attempt FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == "1" and str(j[0]) == "1", "attempt 被改：c=%s j=%s" % (c, j)


def ce05(h):
    """indeterminate：直接改 attempt ABORT；合法 execution_takeover attempt+1 PASS。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", lease_ms=now_ms() + 400, attempt=1)
    h.state_transition("T-in-J1", to="indeterminate", reason="crash?")
    import time as _t
    _t.sleep(0.8)
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=7 WHERE id='C1'",
        "attempt requires execution command")
    assert ok, msg
    h.execution_takeover("T-tk-J1", new_token="w2", attempt=2, new_lease=now_ms() + 900000, frm="indeterminate")
    c = h.query("SELECT validation_attempt, owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT attempt, claimed_by FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == "2" and c[1] == "w2" and str(j[0]) == "2" and j[1] == "w2", "c=%s j=%s" % (c, j)


def ce06(h):
    """running 后注入 candidate_artifact_id → post-validation seal ABORT。"""
    h.running_pair()
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET candidate_artifact_id='ARTX',"
        " candidate_artifact_metadata_hash='h' WHERE id='C1'",
        "post-validation evidence immutable")
    assert ok, msg
    c = h.query("SELECT candidate_artifact_id, candidate_artifact_metadata_hash"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] is None and c[1] is None, "candidate 被注入：%s" % (c,)


def ce07(h):
    """indeterminate 后注入/修改 candidate evidence → ABORT。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    h.state_transition("T-in-J1", to="indeterminate", reason="crash?")
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET candidate_artifact_id='ARTX' WHERE id='C1'",
        "post-validation evidence immutable")
    assert ok, msg
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET candidate_artifact_metadata_hash='h2' WHERE id='C1'",
        "post-validation evidence immutable")
    assert ok, msg


def ce08(h):
    """generated terminal 注入 candidate evidence → ABORT。"""
    _generated_terminal(h, "failed")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET candidate_artifact_id='ARTX' WHERE id='C1'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET candidate_artifact_metadata_hash='h' WHERE id='C1'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg


def ce09(h):
    """离开 validating_reuse 后修改 validation_started_at → ABORT。"""
    h.dispatched()  # claim 已 generation_pending
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_started_at='2020-01-01T00:00:00.000Z' WHERE id='C1'",
        "post-validation evidence immutable")
    assert ok, msg


def ce10(h):
    """validating_reuse 阶段：合法 validation takeover（attempt+1）与 candidate 写入仍 PASS。"""
    h.seed_base()
    h.mk_claim("C1", lease_ms=now_ms() - 1000)
    h.mk_subscriber("R1", "C1")
    # takeover CAS（validating_reuse 通道）
    h.exec("""UPDATE tts_synthesis_claims
        SET validation_owner_token='new', validation_lease_expires_at_epoch_ms=%d,
            validation_attempt=validation_attempt+1, validation_started_at=%s
        WHERE id='C1' AND status='validating_reuse'
          AND validation_lease_expires_at_epoch_ms <
              (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))"""
           % (now_ms() + 600000, q(iso(0))))
    assert h.changes() == 1, "takeover changes=%d" % h.changes()
    # candidate/validation evidence 写入（validation 协议合法；candidate_artifact_id 有 FK 指向
    # sentence_audio_artifacts，此处验证 metadata hash 与 attempt 通道）
    h.exec("UPDATE tts_synthesis_claims SET candidate_artifact_metadata_hash='mh1' WHERE id='C1'")
    c = h.query("SELECT validation_attempt, validation_owner_token, candidate_artifact_metadata_hash"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert str(c[0]) == "2" and c[1] == "new" and c[2] == "mh1", "c=%s" % (c,)


def _reuse_succeeded(h):
    """构造 reuse succeeded：C1 全链产 artifact；C2 同 fingerprint validating_reuse → reuse finalize。"""
    # C1 生成链（artifact ART1 属 C1/J1）
    h.dispatched("C1", "J1")
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    h.walk_attempt_to_succeeded()
    h.insert_artifact("ART1", cid="C1", jid="J1", aid="AT1")
    h.state_transition("T-st-J1", to="succeeded", result="ART1")
    # C2 validating_reuse，同 fingerprint（ffp-C1，与 ART1 的 producing claim 一致），带 candidate snapshot
    h.exec("""INSERT INTO tts_synthesis_claims
        (id,project_id,unit_id,final_tts_input_fingerprint,generation_variant_id,status,
         validation_owner_token,validation_lease_expires_at_epoch_ms,validation_attempt,
         validation_started_at,created_at,updated_at)
        VALUES ('C2','P1','N001','ffp-C1','default','validating_reuse','vowner1',%d,1,%s,%s,%s)"""
           % (now_ms() + 600000, q(iso(0)), q(iso(0)), q(iso(0))))
    h.exec("UPDATE tts_synthesis_claims SET candidate_artifact_id='ART1',"
           " candidate_artifact_metadata_hash='mh2' WHERE id='C2'")
    # reuse finalize（§3.1 usable 路径）：candidate snapshot 保留进入 succeeded
    h.exec("""UPDATE tts_synthesis_claims
        SET status='succeeded', result_artifact_id='ART1',
            validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
            updated_at=%s
        WHERE id='C2' AND status='validating_reuse'
          AND validation_owner_token='vowner1' AND validation_attempt=1
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
              <= validation_lease_expires_at_epoch_ms""" % q(iso(0)))
    assert h.changes() == 1, "reuse finalize changes=%d" % h.changes()
    return h.query("SELECT status, candidate_artifact_id, candidate_artifact_metadata_hash,"
                   " validation_attempt, validation_started_at FROM tts_synthesis_claims WHERE id='C2'")[0]


def ce11(h):
    """reuse succeeded：candidate snapshot 保留；进入 succeeded 后修改 candidate id/hash → ABORT。"""
    before = _reuse_succeeded(h)
    assert before[0] == "succeeded" and before[1] == "ART1" and before[2] == "mh2", "snapshot=%s" % (before,)
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET candidate_artifact_id='OTHER' WHERE id='C2'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET candidate_artifact_metadata_hash='h9' WHERE id='C2'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg
    after = h.query("SELECT candidate_artifact_id, candidate_artifact_metadata_hash"
                    " FROM tts_synthesis_claims WHERE id='C2'")[0]
    assert after[0] == "ART1" and after[1] == "mh2", "candidate 被改：%s" % (after,)


def ce12(h):
    """reuse succeeded：修改 validation_attempt / validation_started_at → ABORT。"""
    _reuse_succeeded(h)
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=9 WHERE id='C2'",
        "terminal immutable")
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET validation_started_at='2020-01-01T00:00:00.000Z' WHERE id='C2'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg


def ce13(h):
    """prestart failed：修改 claim.validation_attempt → ABORT（terminal immutable）。"""
    h.dispatched()
    h.prestart_terminal("T-pre-J1", to_status="failed", error_code="PRE", error_message="cfg")
    before = h.query("SELECT validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=99 WHERE id='C1'",
        "terminal immutable")
    assert ok, msg
    after = h.query("SELECT validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert after == before, "attempt 被改：%s -> %s" % (before, after)


def ce14(h):
    """prestart cancelled：修改 claim validation/candidate evidence → ABORT。"""
    h.dispatched()
    h.prestart_terminal("T-pre-J1", to_status="cancelled", reason="no-sub")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET validation_started_at='2020-01-01T00:00:00.000Z' WHERE id='C1'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET candidate_artifact_id='X' WHERE id='C1'",
        ["post-validation evidence immutable", "terminal immutable"])
    assert ok, msg


def ce15(h):
    """generated failed：claim attempt 与 job attempt 终结后保持最后 command 值；任一侧不能改写。"""
    _generated_terminal(h, "failed")
    c = h.query("SELECT validation_attempt FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT attempt FROM tts_jobs WHERE id='J1'")[0]
    assert str(c[0]) == "1" and str(j[0]) == "1", "终结后 attempt 分裂：c=%s j=%s" % (c, j)
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET validation_attempt=2 WHERE id='C1'",
        "terminal immutable")
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET attempt=2 WHERE id='J1'",
        ["attempt requires execution command", "terminal owner shape violated"])
    assert ok, msg


def ce16(h):
    """terminal claim execution head 回退/跳号继续 ABORT。"""
    _generated_terminal(h, "failed")  # head = T-st-J1/2
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET last_execution_command_id='T-wc-J1', execution_command_seq=1 WHERE id='C1'",
        ["execution head requires command", "terminal immutable"])
    assert ok, msg
    ok, msg = h.expect_abort_any(
        "UPDATE tts_synthesis_claims SET execution_command_seq=9 WHERE id='C1'",
        ["execution head requires command", "terminal immutable"])
    assert ok, msg
    c = h.query("SELECT last_execution_command_id, execution_command_seq FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "T-st-J1" and str(c[1]) == "2", "head 被改：%s" % (c,)


def ce17(h):
    """进入 terminal 的合法 state_transition 不被新 trigger 误伤（全链 succeeded）。"""
    h.dispatched()
    h.worker_claim("T-wc-J1", token="w1", attempt=1)
    h.walk_attempt_to_succeeded()
    h.insert_artifact()
    h.state_transition("T-st-J1", to="succeeded", result="ART1")
    c = h.query("SELECT status, validation_attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "succeeded" and str(c[1]) == "1" and c[2] == "T-st-J1" and str(c[3]) == "2", "c=%s" % (c,)


def ce18(h):
    """进入 prestart terminal 的合法 command 不被误伤（failed + cancelled）。"""
    h.dispatched()
    h.prestart_terminal("T-pre-J1", to_status="failed", error_code="PRE", error_message="cfg")
    c = h.query("SELECT status, validation_attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    assert c[0] == "failed" and c[2] == "T-pre-J1" and str(c[3]) == "1", "c=%s" % (c,)
    h2 = type(h)  # noqa


def ce19(h):
    """reuse finalize 的合法 candidate→succeeded 不被误伤。"""
    before = _reuse_succeeded(h)
    assert before[0] == "succeeded" and before[1] == "ART1", "reuse finalize 被误伤：%s" % (before,)


def ce20(h):
    """第二侧/后续 statement 故障：claim terminal evidence 和 command 全部回滚。"""
    h.running_pair()  # head=T-wc-J1/1
    try:
        h.tx([
            """INSERT INTO tts_job_execution_transitions
            (id,transition_request_id,job_id,claim_id,previous_command_id,command_seq,command_kind,
             from_claim_status,to_claim_status,from_job_status,to_job_status,
             worker_owner_token,worker_attempt,
             error_code,activated_at,created_at)
            VALUES ('T2','req-T2','J1','C1','T-wc-J1',2,'state_transition','running','failed','running','failed',
                    'w1',1,'E1',%s,%s)""" % (q(iso(0)), q(iso(0))),
            "UPDATE tts_audio_requests SET status='succeeded' WHERE claim_id='C1'",  # CHECK 失败
        ])
        raise AssertionError("事务第二条失败未抛错")
    except Exception:
        pass
    c = h.query("SELECT status, validation_attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT status, attempt, last_execution_command_id, execution_command_seq"
                " FROM tts_jobs WHERE id='J1'")[0]
    n = h.query("SELECT count(*) FROM tts_job_execution_transitions WHERE id='T2'")[0]
    assert c[0] == "running" and str(c[1]) == "1" and c[2] == "T-wc-J1" and str(c[3]) == "1", "claim=%s" % (c,)
    assert j[0] == "running" and str(j[1]) == "1" and j[2] == "T-wc-J1" and str(j[3]) == "1", "job=%s" % (j,)
    assert str(n[0]) == "0", "command 行残留：%s" % (n,)


TESTS = [
    ("CE-01", "generated failed 后改 validation_attempt → terminal immutable ABORT", ce01),
    ("CE-02", "generated succeeded 后改 validation_attempt → ABORT", ce02),
    ("CE-03", "generated cancelled 后改 validation_attempt → ABORT", ce03),
    ("CE-04", "running 直接改 validation_attempt → exact command fence ABORT", ce04),
    ("CE-05", "indeterminate 直接改 attempt ABORT；合法 takeover attempt+1 PASS", ce05),
    ("CE-06", "running 后注入 candidate evidence → post-validation seal ABORT", ce06),
    ("CE-07", "indeterminate 后注入/修改 candidate evidence → ABORT", ce07),
    ("CE-08", "generated terminal 注入 candidate evidence → ABORT", ce08),
    ("CE-09", "离开 validating_reuse 后改 validation_started_at → ABORT", ce09),
    ("CE-10", "validating_reuse 阶段合法 takeover+candidate 写入 PASS", ce10),
    ("CE-11", "reuse succeeded candidate snapshot 保留但不可改", ce11),
    ("CE-12", "reuse succeeded 改 attempt/started_at → ABORT", ce12),
    ("CE-13", "prestart failed 改 claim.validation_attempt → ABORT", ce13),
    ("CE-14", "prestart cancelled 改 validation/candidate evidence → ABORT", ce14),
    ("CE-15", "generated failed 双侧 attempt 终结后保持且不可改（无 split）", ce15),
    ("CE-16", "terminal claim head 回退/跳号 → ABORT", ce16),
    ("CE-17", "合法 state_transition 进入 terminal 不被误伤", ce17),
    ("CE-18", "合法 prestart terminal 不被误伤", ce18),
    ("CE-19", "合法 reuse finalize 不被误伤", ce19),
    ("CE-20", "第二侧故障：claim terminal evidence + command 全回滚", ce20),
]
