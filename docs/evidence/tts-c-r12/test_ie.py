"""IE-01..IE-13：indeterminate entry evidence seal + exact-attempt resolve 回归（R9 ②③ 保留项）。"""
from contract_runner import SHA_B, SHA_E, SHA_2, iso, q


def _pub_at(h, stage):
    h.mk_materialization("M1")
    h.mk_publication("PUB1", "materialization_publish", "M1", "publish_and_cutover")
    if stage in ("candidate_persisted", "file_durable", "activation_pending"):
        h.pub_to_candidate("PUB1", SHA_E)
    if stage in ("file_durable", "activation_pending"):
        h.pub_to_file_durable("PUB1")
    if stage == "activation_pending":
        h.pub_to_activation_pending("PUB1")


def _to_indet_sql(from_status, extra=""):
    return """UPDATE voice_registry_publications
        SET status='indeterminate', indeterminate_from_status=%s, owner_token=NULL,
            lease_expires_at_epoch_ms=NULL, updated_at=%s %s
        WHERE id='PUB1'""" % (q(from_status), q(iso(0)), extra)


def _indet_fixture(h):
    _pub_at(h, "activation_pending")
    h.exec(_to_indet_sql("activation_pending"))


def _resolve(h, attempt=1, obs=SHA_E, res_ev="proof", res_hash=SHA_2, owner=None,
             mode="indeterminate_reconciliation"):
    ot = "NULL" if owner is None else q(owner)
    re_ = "NULL" if res_ev is None else q(res_ev)
    rh = "NULL" if res_hash is None else q(res_hash)
    return """INSERT INTO voice_registry_publication_activations
        (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
         activation_mode,resolution_evidence,resolution_evidence_hash,created_at)
        VALUES ('ACT1','PUB1',%s,%d,%s,%s,%s,%s,%s,%s)""" % (
        ot, attempt, q(obs), q(iso(0)), q(mode), re_, rh, q(iso(0)))


def ie01(h):
    h.seed_base(); _pub_at(h, "building")
    ok, msg = h.expect_abort(_to_indet_sql("building", ", candidate_registry_sha256='%s'" % SHA_E),
                             "indeterminate entry evidence seal")
    assert ok, msg


def ie02(h):
    h.seed_base(); _pub_at(h, "building")
    ok, msg = h.expect_abort(_to_indet_sql("building", ", candidate_manifest_json='{\"x\":1}'"),
                             "indeterminate entry evidence seal")
    assert ok, msg


def ie03(h):
    h.seed_base(); _pub_at(h, "candidate_persisted")
    ok, msg = h.expect_abort(_to_indet_sql("candidate_persisted", ", file_durable_at='2026-01-01T00:00:00.000Z'"),
                             "indeterminate entry evidence seal")
    assert ok, msg


def ie04(h):
    h.seed_base(); _pub_at(h, "file_durable")
    ok, msg = h.expect_abort(_to_indet_sql("file_durable", ", activation_requested_at='2026-01-01T00:00:00.000Z'"),
                             "indeterminate entry evidence seal")
    assert ok, msg


def ie05(h):
    """进入 indeterminate 时清除已有证据 → seal ABORT。"""
    h.seed_base(); _pub_at(h, "candidate_persisted")
    ok, msg = h.expect_abort(_to_indet_sql("candidate_persisted", ", candidate_registry_sha256=NULL"),
                             "indeterminate entry evidence seal")
    assert ok, msg


def ie06(h):
    """exact source-shape 不变进入 → PASS；evidence 保持 OLD 值。"""
    h.seed_base(); _pub_at(h, "activation_pending")
    h.exec(_to_indet_sql("activation_pending"))
    p = h.query("SELECT status,indeterminate_from_status,candidate_registry_sha256,file_durable_at,activation_requested_at FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert p[0] == "indeterminate" and p[1] == "activation_pending" and p[2] == SHA_E and p[3] and p[4], "p=%s" % (p,)


def ie06b(h):
    h.seed_base(); _pub_at(h, "file_durable")
    ok, msg = h.expect_abort(_to_indet_sql("activation_pending"),
                             "indeterminate origin required")
    assert ok, msg


def ie07(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, attempt=2), "fencing mismatch")
    assert ok, msg


def ie08a(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, attempt=0), "CHECK constraint failed")
    assert ok, msg


def ie08b(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, attempt=-3), "CHECK constraint failed")
    assert ok, msg


def ie09(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, res_ev=None), "resolution_evidence required")
    assert ok, msg


def ie10(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, res_hash=None), "resolution_evidence required")
    assert ok, msg


def ie11(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, owner="someone"), "CHECK constraint failed")
    assert ok, msg


def ie12(h):
    h.seed_base(); _indet_fixture(h)
    ok, msg = h.expect_abort(_resolve(h, obs=SHA_B), "fencing mismatch")
    assert ok, msg


def ie13(h):
    """exact attempt/evidence reconciliation → PASS：publication active + projection 发布。"""
    h.seed_base(); _indet_fixture(h)
    h.exec(_resolve(h))
    p = h.query("SELECT status,owner_token,activated_at FROM voice_registry_publications WHERE id='PUB1'")[0]
    m = h.query("SELECT status,published_registry_sha256,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    assert p[0] == "active" and p[1] is None and p[2], "p=%s" % (p,)
    assert m == ("published_usable", SHA_E, "PUB1"), "m=%s" % (m,)


def ie14(h):
    """indeterminate 期间补写 evidence → immutable ABORT。"""
    h.seed_base(); _pub_at(h, "candidate_persisted")
    h.exec(_to_indet_sql("candidate_persisted"))
    ok, msg = h.expect_abort(
        "UPDATE voice_registry_publications SET file_durable_at=%s WHERE id='PUB1'" % q(iso(0)),
        "immutable field")
    assert ok, msg


TESTS = [
    ("IE-01", "building→indeterminate 同步写 candidate SHA → seal ABORT", ie01),
    ("IE-02", "building→indeterminate 同步写 manifest → seal ABORT", ie02),
    ("IE-03", "candidate_persisted→indeterminate 同步写 file_durable_at → seal ABORT", ie03),
    ("IE-04", "file_durable→indeterminate 同步写 activation_requested_at → seal ABORT", ie04),
    ("IE-05", "进入 indeterminate 清除已有证据 → seal ABORT", ie05),
    ("IE-06", "exact source-shape 不变进入 → PASS", ie06),
    ("IE-06b", "indeterminate_from_status 谎称来源 → origin required ABORT", ie06b),
    ("IE-07", "resolve attempt 不匹配 → fencing ABORT", ie07),
    ("IE-08a", "resolve attempt=0 → CHECK ABORT", ie08a),
    ("IE-08b", "resolve attempt 负数 → CHECK ABORT", ie08b),
    ("IE-09", "resolve resolution_evidence NULL → ABORT", ie09),
    ("IE-10", "resolve resolution_evidence_hash NULL → ABORT", ie10),
    ("IE-11", "resolve owner_token 非法非 NULL → CHECK ABORT", ie11),
    ("IE-12", "observed SHA ≠ persisted candidate SHA → fencing ABORT", ie12),
    ("IE-13", "exact attempt/evidence reconciliation → PASS（active + projection 发布）", ie13),
    ("IE-14", "indeterminate 期间补写 evidence → immutable ABORT", ie14),
]
