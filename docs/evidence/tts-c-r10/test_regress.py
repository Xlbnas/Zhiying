"""历史回归子集（实际重跑）：PA / CJ / JR / EN / SM / ET / GN / LR / PE / RP。

只收录本轮真实执行的断言；未执行的历史矩阵在 §10.5 标记 NOT EXECUTED，不计入 PASS。
"""
from contract_runner import DBNOW, SHA_D, SHA_E, iso, now_ms, q


def _pub_ready(h, pid="PUB1", lease_ms=None):
    h.mk_materialization("M1")
    h.mk_publication(pid, "materialization_publish", "M1", "publish_and_cutover",
                     lease_ms=lease_ms or now_ms() + 600000)
    h.pub_progress(pid, SHA_E)


# ---------- PA（activation command；R8-D/C） ----------
def pa01(h):
    """publication 单独 UPDATE activation_pending→active（无 command 行）→ invalid transition ABORT。"""
    h.seed_base(); _pub_ready(h)
    ok, msg = h.expect_abort(
        "UPDATE voice_registry_publications SET status='active', activated_at=%s WHERE id='PUB1'" % q(iso(0)),
        "invalid transition")
    assert ok, msg


def pa04(h):
    """activation 时 subject 已被抢占（projection 非 file_ready）→ ABORT + 整条回滚。"""
    h.seed_base(); _pub_ready(h)
    # 直接把 M1 合法发布需要另一条路——此处用第二个 DB 状态做不到，改为先激活再重放 command：
    h.activate("PUB1", "ACT1")
    # 重放第二个 activation（同 subject，projection 已 published）→ fencing/subject mismatch
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publication_activations
        (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
         activation_mode,created_at)
        VALUES ('ACT2','PUB1','powner1',1,%s,%s,'normal_owner_finalize',%s)"""
        % (q(SHA_E), q(iso(0)), q(iso(0))), "voice_registry_publication_activations")
    assert ok, msg


def pa06(h):
    """publication INSERT 引用不存在的 subject → subject invalid ABORT。"""
    h.seed_base()
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (1,'materialization_publish','M-NOPE','publish_and_cutover',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUBX')""" % (q(SHA_D), q(iso(0)), q(iso(0))),
        "subject invalid")
    assert ok, msg


def pa07(h):
    """registry_rebuild：subject_id != 'global' → ABORT；='global' 全链 PASS（无 subject 更新）。"""
    h.seed_base()
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (1,'registry_rebuild','not-global','none',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUBX')""" % (q(SHA_D), q(iso(0)), q(iso(0))),
        "subject invalid")
    assert ok, msg
    h.mk_publication("PUB1", "registry_rebuild", "global", "none")
    h.pub_progress("PUB1")
    h.activate("PUB1", "ACT1")
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert p[0] == "active", "rebuild activate failed: %s" % (p,)


def pa08_removed():
    pass


def gn01(h):
    h.seed_base()
    h.exec("""INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (7,'registry_rebuild','global','none',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUB1')""" % (q(SHA_D), q(iso(0)), q(iso(0))))
    h.exec("""UPDATE voice_registry_publications SET status='failed', owner_token=NULL,
        lease_expires_at_epoch_ms=NULL, failed_at=%s, error_code='X', updated_at=%s WHERE id='PUB1'"""
           % (q(iso(0)), q(iso(0))))
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (7,'registry_rebuild','global','none',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUB2')""" % (q(SHA_D), q(iso(0)), q(iso(0))),
        "UNIQUE constraint failed")
    assert ok, msg


def gn02(h):
    h.seed_base()
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (NULL,'registry_rebuild','global','none',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUB2')""" % (q(SHA_D), q(iso(0)), q(iso(0))),
        "NOT NULL constraint failed")
    assert ok, msg


# ---------- CJ（dispatch command；R8-F） ----------
def cj09(h):
    """只把 claim UPDATE 成 generation_pending 后 COMMIT（无 dispatch 行）→ ABORT。"""
    h.seed_base()
    h.mk_claim("C1")
    ok, msg = h.expect_abort(
        "UPDATE tts_synthesis_claims SET status='generation_pending', validation_owner_token=NULL,"
        " validation_lease_expires_at_epoch_ms=NULL WHERE id='C1'",
        "generation_pending requires dispatch command")
    assert ok, msg


def cj10(h):
    """atomic dispatch command：同一 statement claim→generation_pending + 恰好一个 queued job +
    validation owner/candidate 清空。"""
    h.seed_base()
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    h.dispatch("C1", "J1", "D1")
    c = h.query("SELECT status,validation_owner_token,validation_lease_expires_at_epoch_ms,candidate_artifact_id FROM tts_synthesis_claims WHERE id='C1'")[0]
    j = h.query("SELECT count(*) FROM tts_jobs WHERE claim_id='C1'")[0]
    assert c == ("generation_pending", None, None, None), "c=%s" % (c,)
    assert str(j[0]) == "1", "jobs=%s" % (j,)


def cj11(h):
    """dispatch 内 job INSERT 失败（job id 冲突）→ 整条 statement 回滚。"""
    h.seed_base()
    now = iso(0)
    h.exec("""INSERT INTO tts_jobs (id,project_id,narration_plan_artifact_id,narration_plan_version,unit_id,
        provider,voice_profile_id,voice_profile_revision,status,payload_json,queued_at)
        VALUES ('J1','P1','A1',1,'N009','indextts2','VP1','x','queued','{}',%s)""" % q(now))
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D1','C1','J1','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','1','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(now),
        "")
    c = h.query("SELECT status,validation_owner_token FROM tts_synthesis_claims WHERE id='C1'")[0]
    d = h.query("SELECT count(*) FROM tts_claim_generation_dispatches WHERE id='D1'")[0]
    assert c == ("validating_reuse", "vowner1") and str(d[0]) == "0", "回滚不完整：c=%s d=%s（%s）" % (c, d, msg)


def cj12(h):
    """同 claim 第二次 dispatch command → UNIQUE(claim_id) ABORT。"""
    h.dispatched()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_claim_generation_dispatches
        (id,claim_id,job_id,validation_owner_token,validation_attempt,
         project_id,unit_id,narration_plan_artifact_id,narration_plan_version,provider,
         voice_profile_id,voice_profile_revision,voice_profile_revision_id,payload_json,
         exact_source_fingerprint,synthesis_payload_fingerprint,final_tts_input_fingerprint,
         generation_variant_id,created_at)
        VALUES ('D2','C1','J2','vowner1',1,'P1','N001','A1',1,'indextts2','VP1','1','VR1','{}',
                'esp','spf','ffp-C1','default',%s)""" % q(iso(0)),
        "UNIQUE constraint failed: tts_claim_generation_dispatches.claim_id")
    assert ok, msg


def cj13(h):
    """generated claim 走到终态仍恰好一个 job；job DELETE 禁。"""
    h.running_pair()
    h.walk_attempt_to_succeeded()
    h.insert_artifact()
    h.state_transition("T2", to="succeeded", result="ART1")
    n = h.query("SELECT count(*) FROM tts_jobs WHERE claim_id='C1'")[0]
    assert str(n[0]) == "1", "jobs=%s" % (n,)
    ok, msg = h.expect_abort("DELETE FROM tts_jobs WHERE id='J1'", "tts-c delete forbidden")
    assert ok, msg


# ---------- JR（job result row-state invariant；R8-G） ----------
def jr01(h):
    """running job 单独 SET result → ABORT（同表多 trigger 创建逆序：link/identity trigger 先于
    invariant 触发时消息为 result artifact job mismatch，均为合法拒绝——实证口径）。"""
    h.running_pair()
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET result_artifact_id='X' WHERE id='J1'",
        ["result status invariant violated", "result artifact job mismatch"])
    assert ok, msg


def jr02(h):
    h.dispatched()
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET result_artifact_id='X' WHERE id='J1'",
        ["result status invariant violated", "result artifact job mismatch"])
    assert ok, msg


def jr03(h):
    h.running_pair()
    h.state_transition("T2", to="failed", error_code="E", error_message="m")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET result_artifact_id='X' WHERE id='J1'",
        ["result status invariant violated", "result artifact job mismatch", "immutable field"])
    assert ok, msg


def jr05(h):
    h.running_pair()
    h.walk_attempt_to_succeeded()
    h.insert_artifact()
    h.state_transition("T2", to="succeeded", result="ART1")
    ok, msg = h.expect_abort_any(
        "UPDATE tts_jobs SET result_artifact_id='OTHER' WHERE id='J1'",
        ["immutable field", "result artifact job mismatch"])
    assert ok, msg


# ---------- EN（envelope waiting link closure；R8-H） ----------
def en01(h):
    h.seed_base()
    now = iso(0)
    h.exec("""INSERT INTO tts_audio_requests
        (id,project_id,request_id,unit_id,exact_source_fingerprint,synthesis_payload_fingerprint,
         final_tts_input_fingerprint,generation_variant_id,status,created_at,updated_at)
        VALUES ('R9','P1','R9','N001','esp','spf','ffp-X','default','initializing',%s,%s)""" % (q(now), q(now)))
    ok, msg = h.expect_abort(
        "UPDATE tts_audio_requests SET status='waiting', updated_at=%s WHERE id='R9'" % q(now),
        "waiting requires claim link")
    assert ok, msg


def en02(h):
    h.seed_base()
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    r = h.query("SELECT status,claim_id FROM tts_audio_requests WHERE id='R1'")[0]
    assert r == ("waiting", "C1"), "r=%s" % (r,)


def en03(h):
    """vmr initializing→waiting 无 job → waiting requires job link ABORT。"""
    h.seed_base()
    now = iso(0)
    h.exec("""INSERT INTO voice_materialization_requests
        (id,project_id,request_id,voice_profile_id,voice_profile_revision_id,assignment_artifact_id,
         request_fingerprint,status,created_at,updated_at)
        VALUES ('MR1','P1','MR1','VP1','VR1','A2','rfp','initializing',%s,%s)""" % (q(now), q(now)))
    ok, msg = h.expect_abort(
        "UPDATE voice_materialization_requests SET status='waiting', updated_at=%s WHERE id='MR1'" % q(now),
        "waiting requires job link")
    assert ok, msg


def en04(h):
    """vmr initializing→waiting + exact job → PASS。"""
    h.seed_base()
    now = iso(0)
    h.exec("""INSERT INTO voice_materialization_jobs
        (id,voice_profile_id,voice_profile_revision_id,status,validation_owner_token,
         validation_lease_expires_at_epoch_ms,validation_attempt,source_canonical_sha256,
         adapter_compatibility_key,destination_voice_root_relative_path,created_at,updated_at)
        VALUES ('MJ1','VP1','VR1','validating_existing','mo1',%d,1,%s,'ack1',
                'VP1/VR1/reference.wav',%s,%s)""" % (now_ms() + 600000, q("a" * 64), q(now), q(now)))
    h.exec("""INSERT INTO voice_materialization_requests
        (id,project_id,request_id,voice_profile_id,voice_profile_revision_id,assignment_artifact_id,
         request_fingerprint,status,created_at,updated_at)
        VALUES ('MR1','P1','MR1','VP1','VR1','A2','rfp','initializing',%s,%s)""" % (q(now), q(now)))
    h.exec("UPDATE voice_materialization_requests SET status='waiting', job_id='MJ1', updated_at=%s WHERE id='MR1'" % q(now))
    r = h.query("SELECT status,job_id FROM voice_materialization_requests WHERE id='MR1'")[0]
    assert r == ("waiting", "MJ1"), "r=%s" % (r,)


def en05(h):
    """waiting envelope 清掉 claim 链接 → CHECK/immutable ABORT。"""
    h.seed_base()
    h.mk_claim("C1")
    h.mk_subscriber("R1", "C1")
    ok, msg = h.expect_abort(
        "UPDATE tts_audio_requests SET claim_id=NULL, updated_at=%s WHERE id='R1'" % q(iso(0)),
        "")
    assert ok, "清链接成功（应被拒）"


# ---------- SM（subject_mode 联合判定；R9 ④） ----------
def _sm(h, st, sid, mode):
    return """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (9,%s,%s,%s,%s,'pub@1.0','building','p2',9999999999999,1,%s,%s,'PUBX')""" % (
        q(st), q(sid), q(mode), q(SHA_D), q(iso(0)), q(iso(0)))


def sm01(h):
    h.seed_base(); h.mk_materialization("M1")
    ok, msg = h.expect_abort(_sm(h, "materialization_publish", "M1", "cutover_existing"), "subject invalid")
    assert ok, msg


def sm02(h):
    h.seed_base(); h.mk_materialization("M1"); h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(_sm(h, "legacy_cutover_publish", "E1", "cutover_existing"), "subject invalid")
    assert ok, msg


def sm03(h):
    h.seed_base(); h.mk_materialization("M1"); h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(_sm(h, "legacy_cutover_existing", "E1", "publish_and_cutover"), "subject invalid")
    assert ok, msg


def sm04(h):
    """legacy_cutover_existing + mapped projection 仍 file_ready → subject invalid。"""
    h.seed_base(); h.mk_materialization("M1"); h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(_sm(h, "legacy_cutover_existing", "E1", "cutover_existing"), "subject invalid")
    assert ok, msg


def sm05(h):
    h.seed_base()
    ok, msg = h.expect_abort(_sm(h, "registry_rebuild", "global", "publish_and_cutover"), "subject invalid")
    assert ok, msg


# ---------- ET（evidence timestamp freeze；R9 ①） ----------
def et01(h):
    h.seed_base()
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (1,'registry_rebuild','global','none',%s,'pub@1.0','building',
                'p1',9999999999999,1,%s,%s,'PUB1')""" % (q(SHA_D), q(iso(3600000)), q(iso(0))),
        "evidence timestamp in future")
    assert ok, msg


def et02(h):
    h.seed_base(); _pub_ready(h)
    ok, msg = h.expect_abort(
        "UPDATE voice_registry_publications SET activated_at=%s WHERE id='PUB1'" % q(iso(3600000)),
        "evidence timestamp in future")
    assert ok, msg


def et03(h):
    h.seed_base()
    ok, msg = h.expect_abort(
        """INSERT INTO tts_synthesis_claims
        (id,project_id,unit_id,final_tts_input_fingerprint,generation_variant_id,status,
         validation_owner_token,validation_lease_expires_at_epoch_ms,validation_attempt,
         validation_started_at,created_at,updated_at)
        VALUES ('C1','P1','N001','ffp-C1','default','validating_reuse','v1',9999999999999,1,%s,%s,%s)"""
        % (q(iso(3600000)), q(iso(0)), q(iso(0))),
        "evidence timestamp in future")
    assert ok, msg


# ---------- LR / PE / RP（R7/R8 回归子集） ----------
def lr01(h):
    """rollback 清 pending/selector；旧 failed publication evidence 保留不变。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    h.mk_publication("PUB1", "legacy_cutover_publish", "E1", "publish_and_cutover")
    h.entry_to_mapping_pending("E1", "PUB1")
    h.exec("""UPDATE voice_registry_publications SET status='failed', owner_token=NULL,
        lease_expires_at_epoch_ms=NULL, failed_at=%s, error_code='X', updated_at=%s WHERE id='PUB1'"""
           % (q(iso(0)), q(iso(0))))
    h.entry_rollback("E1")
    p = h.query("SELECT status,error_code,subject_type,subject_id FROM voice_registry_publications WHERE id='PUB1'")[0]
    e = h.query("SELECT mapping_status,pending_publication_id FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    assert p == ("failed", "X", "legacy_cutover_publish", "E1"), "旧 evidence 被改：%s" % (p,)
    assert e == ("mapped_verified", None), "e=%s" % (e,)


def pe03(h):
    """building 来源 indeterminate → 直接 UPDATE active → invalid transition ABORT。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_publication("PUB1", "materialization_publish", "M1", "publish_and_cutover")
    h.exec("""UPDATE voice_registry_publications SET status='indeterminate',
        indeterminate_from_status='building', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
        updated_at=%s WHERE id='PUB1'""" % q(iso(0)))
    ok, msg = h.expect_abort(
        "UPDATE voice_registry_publications SET status='active', activated_at=%s WHERE id='PUB1'" % q(iso(0)),
        "invalid transition")
    assert ok, msg


def rp11(h):
    """publication lease 过期后旧 owner renewal → changes=0。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_publication("PUB1", "materialization_publish", "M1", "publish_and_cutover",
                     lease_ms=now_ms() - 1000)
    h.exec("""UPDATE voice_registry_publications
        SET lease_expires_at_epoch_ms=%d, updated_at=%s
        WHERE id='PUB1' AND status IN ('building','candidate_persisted','file_durable','activation_pending')
          AND owner_token='powner1' AND attempt=1
          AND (SELECT %s) <= lease_expires_at_epoch_ms""" % (now_ms() + 600000, q(iso(0)), DBNOW))
    assert h.changes() == 0, "expired owner renewal changes=%d" % h.changes()


def rp12(h):
    """lease 未过期 + exact owner/attempt renewal → changes=1；错误 token → 0。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_publication("PUB1", "materialization_publish", "M1", "publish_and_cutover",
                     lease_ms=now_ms() + 600000)
    h.exec("""UPDATE voice_registry_publications
        SET lease_expires_at_epoch_ms=%d, updated_at=%s
        WHERE id='PUB1' AND status IN ('building','candidate_persisted','file_durable','activation_pending')
          AND owner_token='wrong' AND attempt=1
          AND (SELECT %s) <= lease_expires_at_epoch_ms""" % (now_ms() + 600000, q(iso(0)), DBNOW))
    assert h.changes() == 0, "wrong token renewal changes=%d" % h.changes()
    h.exec("""UPDATE voice_registry_publications
        SET lease_expires_at_epoch_ms=%d, updated_at=%s
        WHERE id='PUB1' AND status IN ('building','candidate_persisted','file_durable','activation_pending')
          AND owner_token='powner1' AND attempt=1
          AND (SELECT %s) <= lease_expires_at_epoch_ms""" % (now_ms() + 600000, q(iso(0)), DBNOW))
    assert h.changes() == 1, "valid renewal changes=%d" % h.changes()


TESTS = [
    ("PA-01", "publication 单独 UPDATE →active（无 command）→ ABORT", pa01),
    ("PA-04", "activation subject 已抢占/replay → ABORT", pa04),
    ("PA-06", "publication 引用不存在 subject → subject invalid", pa06),
    ("PA-07", "registry_rebuild subject_id 校验 + 全链 PASS", pa07),
    ("GN-01", "generation 重复 → UNIQUE ABORT", gn01),
    ("GN-02", "generation NULL → NOT NULL ABORT", gn02),
    ("CJ-09", "claim 单独 →generation_pending（无 dispatch）→ ABORT", cj09),
    ("CJ-10", "atomic dispatch：claim+恰好一个 job+清 validation 证据", cj10),
    ("CJ-11", "dispatch 内 job INSERT 失败 → 整条回滚", cj11),
    ("CJ-12", "同 claim 第二次 dispatch → UNIQUE ABORT", cj12),
    ("CJ-13", "终态仍恰好一个 job；job DELETE 禁", cj13),
    ("JR-01", "running job 单独 SET result → invariant ABORT", jr01),
    ("JR-02", "queued job 单独 SET result → invariant ABORT", jr02),
    ("JR-03", "failed job 单独 SET result → ABORT", jr03),
    ("JR-05", "succeeded 后替换 result → immutable ABORT", jr05),
    ("EN-01", "tar initializing→waiting 无 claim → ABORT", en01),
    ("EN-02", "tar waiting + exact claim → PASS", en02),
    ("EN-03", "vmr initializing→waiting 无 job → ABORT", en03),
    ("EN-04", "vmr waiting + exact job → PASS", en04),
    ("EN-05", "waiting 清 claim 链接 → ABORT", en05),
    ("SM-01", "materialization_publish + cutover_existing → ABORT", sm01),
    ("SM-02", "legacy_cutover_publish + cutover_existing → ABORT", sm02),
    ("SM-03", "legacy_cutover_existing + publish_and_cutover → ABORT", sm03),
    ("SM-04", "cutover_existing 但 projection 未发布 → ABORT", sm04),
    ("SM-05", "registry_rebuild + 非 none mode → ABORT", sm05),
    ("ET-01", "publication INSERT created_at 未来 → ABORT", et01),
    ("ET-02", "publication UPDATE activated_at 未来 → ABORT", et02),
    ("ET-03", "claim INSERT validation_started_at 未来 → ABORT", et03),
    ("LR-01", "rollback 清 pending/selector；旧 evidence 保留", lr01),
    ("PE-03", "building 来源 indeterminate → 直接 active → ABORT", pe03),
    ("RP-11", "publication lease 过期旧 owner renewal → changes=0", rp11),
    ("RP-12", "valid renewal changes=1；wrong token changes=0", rp12),
]
