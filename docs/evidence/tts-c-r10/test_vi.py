"""VI-05..VI-08：TTS job legacy/exact voice identity 回归（R9 ⑦ 保留项；消息文本按 R10 实证修正）。"""
from contract_runner import iso, q


def vi05(h):
    """TTS-C job 修改 voice_profile_revision → ABORT（实证消息 = compat mismatch；
    同表多 trigger 创建逆序，compat trigger 先于 immutable 触发——行为=禁止修改）。"""
    h.dispatched()
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET voice_profile_revision='99' WHERE id='J1'",
        "tts_jobs")
    assert ok, msg
    j = h.query("SELECT voice_profile_revision FROM tts_jobs WHERE id='J1'")[0]
    assert j[0] == "1", "revision 被修改：%s" % (j,)
    # 修改 voice_profile_revision_id 同样被拦截
    ok, msg = h.expect_abort(
        "UPDATE tts_jobs SET voice_profile_revision_id='VRX' WHERE id='J1'",
        "tts_jobs")
    assert ok, msg


def vi06(h):
    """exact revision ID 与 legacy revision number 不一致 → compat ABORT + 整条 dispatch 回滚。"""
    h.seed_base()
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D1','C1','J1','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','2','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(iso(0)),
        "voice_profile_revision compat mismatch")
    assert ok, msg
    c = h.query("SELECT status,validation_owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT count(*) FROM tts_jobs WHERE id='J1'")[0]
    d = h.query("SELECT count(*) FROM tts_claim_generation_dispatches WHERE id='D1'")[0]
    assert c == ("validating_reuse", "vowner1") and str(j[0]) == "0" and str(d[0]) == "0", \
        "回滚不完整：c=%s j=%s d=%s" % (c, j, d)


def vi07(h):
    """CAST(revision_number AS TEXT) 格式边界：'01'/'1.0'/' 1'/'1 ' 全拒；'1' 与 '10' 接受。"""
    h.seed_base()
    for i, txt in enumerate(("01", "1.0", " 1", "1 ")):
        cid = "CF%d" % i
        h.mk_claim(cid)
        h.mk_subscriber("RF%d" % i, cid)
        ok, msg = h.expect_abort(
            """INSERT INTO tts_claim_generation_dispatches
            (id,claim_id,job_id,validation_owner_token,validation_attempt,
             project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
             voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
             exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
             generation_variant_id,created_at)
            VALUES ('D%d','%s','J%d','vowner1',1,'P1','N001','A1',1,'indextts2','VP1',%s,'VR1','{}',
                    'esp','spf','ffp-%s','default',%s)""" % (i, cid, i, q(txt), cid, q(iso(0))),
            "compat mismatch")
        assert ok, "format %r accepted: %s" % (txt, msg)


def vi07b(h):
    """revision_number=10 → CAST='10' exact 匹配。"""
    h.seed_base(revision_number=10)
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    h.dispatch("C1", "J1", "D1", rev_text="10")
    j = h.query("SELECT voice_profile_revision,voice_profile_revision_id FROM tts_jobs WHERE id='J1'")[0]
    assert j == ("10", "VR1"), "j=%s" % (j,)


def vi08(h):
    """legacy job（claim_id NULL）不受 TTS-C trigger 影响；不得反向获得 claim_id。"""
    h.seed_base()
    now = iso(0)
    h.exec("""INSERT INTO tts_jobs (id,project_id,narration_plan_artifact_id,narration_plan_version,unit_id,
        provider,voice_profile_id,voice_profile_revision,status,payload_json,queued_at)
        VALUES ('JL1','P1','A1',1,'N001','indextts2','VP1','legacy-rev','queued','{}',%s)""" % q(now))
    h.exec("UPDATE tts_jobs SET voice_profile_revision='changed-anything' WHERE id='JL1'")
    h.exec("UPDATE tts_jobs SET status='running', claimed_by='w', claimed_at=%s, heartbeat_at=%s WHERE id='JL1'"
           % (q(now), q(now)))
    h.exec("UPDATE tts_jobs SET status='queued', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL WHERE id='JL1'")
    j = h.query("SELECT voice_profile_revision,status FROM tts_jobs WHERE id='JL1'")[0]
    assert j == ("changed-anything", "queued"), "legacy 行受限：%s" % (j,)
    # legacy 行不得反向获得 claim_id
    h.dispatched(seed=False)
    ok, msg = h.expect_abort("UPDATE tts_jobs SET claim_id='C1' WHERE id='JL1'", "tts_jobs")
    assert ok, msg


TESTS = [
    ("VI-05", "TTS-C job 修改 voice_profile_revision(/_id) → ABORT（实证消息）", vi05),
    ("VI-06", "revision ID 与 revision number 不一致 → compat ABORT + dispatch 回滚", vi06),
    ("VI-07", "CAST(revision_number AS TEXT) 格式边界（'01'/'1.0'/空格全拒）", vi07),
    ("VI-07b", "revision_number=10 → '10' exact 匹配", vi07b),
    ("VI-08", "legacy 行不受限 + 不得反向获得 claim_id", vi08),
]
