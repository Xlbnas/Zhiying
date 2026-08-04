"""LC-01..LC-12：legacy cutover 双路径可达性 + 竞争裁决 + cardinality/retired（R10 ④⑤）。"""
from contract_runner import SHA_E, iso, q


def _publish_m1(h, pid="PUB0"):
    """普通 materialization_publish 发布 M1 → published_usable。"""
    h.mk_publication(pid, "materialization_publish", "M1", "publish_and_cutover")
    h.pub_progress(pid)
    h.activate(pid, "ACT-" + pid)


def lc01(h):
    """路径 A：file_ready projection → publish_and_cutover 全链 PASS。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    h.mk_publication("PUB1", "legacy_cutover_publish", "E1", "publish_and_cutover")
    h.entry_to_mapping_pending("E1", "PUB1")
    h.pub_progress("PUB1")
    h.activate("PUB1", "ACT1")
    m = h.query("SELECT status,published_registry_sha256,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    e = h.query("SELECT mapping_status,candidate_activated_at,pending_publication_id,mapping_mode FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert m == ("published_usable", SHA_E, "PUB1"), "m=%s" % (m,)
    assert e[0] == "mapped_active" and e[1] and e[2] == "PUB1" and e[3] == "publish_and_cutover", "e=%s" % (e,)
    assert p[0] == "active", "pub=%s" % (p,)


def lc02(h):
    """路径 B：published projection → cutover_existing 全链 PASS（R9 P0-3 修复实证）。"""
    h.seed_base()
    h.mk_materialization("M1")
    _publish_m1(h)
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "cutover_existing")
    h.mk_publication("PUB1", "legacy_cutover_existing", "E1", "cutover_existing")
    h.entry_to_mapping_pending("E1", "PUB1")
    h.pub_progress("PUB1")
    h.activate("PUB1", "ACT1")
    e = h.query("SELECT mapping_status,pending_publication_id FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert e == ("mapped_active", "PUB1"), "e=%s" % (e,)
    assert p[0] == "active", "pub=%s" % (p,)


def lc03(h):
    """cutover_existing 不重写 projection 的旧 publication evidence（零 UPDATE）。"""
    h.seed_base()
    h.mk_materialization("M1")
    _publish_m1(h)
    before = h.query("SELECT status,published_registry_generation,published_registry_sha256,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "cutover_existing")
    h.mk_publication("PUB1", "legacy_cutover_existing", "E1", "cutover_existing")
    h.entry_to_mapping_pending("E1", "PUB1")
    h.pub_progress("PUB1")
    h.activate("PUB1", "ACT1")
    after = h.query("SELECT status,published_registry_generation,published_registry_sha256,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    assert before == after, "projection evidence 被改写：before=%s after=%s" % (before, after)
    assert after[3] == "PUB0", "published_by 仍是旧 publication：%s" % (after,)


def lc04(h):
    """情况 1：entry mapped_verified(publish_and_cutover) 后普通 materialization_publish → ABORT。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (9,'materialization_publish','M1','publish_and_cutover',%s,'pub@1.0','building',
                'p2',9999999999999,1,%s,%s,'PUBX')""" % (q("d" * 64), q(iso(0)), q(iso(0))),
        "subject invalid")
    assert ok, msg


def lc05(h):
    """情况 2：普通 publication 先完成后导入 legacy entry → cutover_existing 映射允许。"""
    h.seed_base()
    h.mk_materialization("M1")
    _publish_m1(h)
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "cutover_existing")
    e = h.query("SELECT mapping_status,mapping_mode FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    assert e == ("mapped_verified", "cutover_existing"), "e=%s" % (e,)


def lc06(h):
    """情况 3：active-flight materialization publication 在飞时建立 publish_and_cutover 映射 → ABORT。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_publication("PUB0", "materialization_publish", "M1", "publish_and_cutover")  # building 在飞
    h.mk_legacy_entry("E1")
    ok, msg = h.expect_abort(
        """UPDATE legacy_adapter_voice_entries
        SET mapping_status='mapped_verified', mapped_voice_materialization_id='M1',
            mapping_mode='publish_and_cutover' WHERE id='E1'""",
        "projection publication in flight")
    assert ok, msg
    # publication 完成（failed）后可重试映射（但 projection 未发布 → 只能等 repair；此处验证在飞裁决确定性：
    # publication 激活后 projection published → cutover_existing 可达，即 LC-02/LC-05）
    h.pub_progress("PUB0")
    h.activate("PUB0", "ACT0")
    h.entry_to_mapped_verified("E1", "M1", "cutover_existing")
    e = h.query("SELECT mapping_status,mapping_mode FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    assert e == ("mapped_verified", "cutover_existing"), "e=%s" % (e,)


def lc07(h):
    """错误 mapping_mode/subject_type 组合 → ABORT。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    # 7a：file_ready projection + cutover_existing 模式 → ABORT
    ok, msg = h.expect_abort(
        """UPDATE legacy_adapter_voice_entries
        SET mapping_status='mapped_verified', mapped_voice_materialization_id='M1',
            mapping_mode='cutover_existing' WHERE id='E1'""",
        "mapped materialization not published_usable")
    assert ok, msg
    # 7b：entry mode=publish_and_cutover，但 publication 用 legacy_cutover_existing → subject invalid
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (9,'legacy_cutover_existing','E1','cutover_existing',%s,'pub@1.0','building',
                'p2',9999999999999,1,%s,%s,'PUBX')""" % (q("d" * 64), q(iso(0)), q(iso(0))),
        "subject invalid")
    assert ok, msg
    # 7c：publication 时 entry 未 mapped_verified（E2 不存在）→ subject invalid
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publications
        (generation,subject_type,subject_id,subject_mode,stable_registry_sha256,publisher_schema_version,
         status,owner_token,lease_expires_at_epoch_ms,attempt,created_at,updated_at,id)
        VALUES (10,'legacy_cutover_publish','E2','publish_and_cutover',%s,'pub@1.0','building',
                'p2',9999999999999,1,%s,%s,'PUBY')""" % (q("d" * 64), q(iso(0)), q(iso(0))),
        "subject invalid")
    assert ok, msg


def lc08(h):
    """activation 时 entry 未 mapping_pending → ABORT + 整条回滚（projection 不被污染）。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    h.mk_publication("PUB1", "legacy_cutover_publish", "E1", "publish_and_cutover")
    h.pub_progress("PUB1")
    ok, msg = h.expect_abort(
        """INSERT INTO voice_registry_publication_activations
        (id,publication_id,owner_token,attempt,observed_active_registry_sha256,activated_at,
         activation_mode,created_at)
        VALUES ('ACT1','PUB1','powner1',1,%s,%s,'normal_owner_finalize',%s)"""
        % (q(SHA_E), q(iso(0)), q(iso(0))),
        "legacy cutover publish subject mismatch")
    assert ok, msg
    m = h.query("SELECT status,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    p = h.query("SELECT status FROM voice_registry_publications WHERE id='PUB1'")[0]
    assert m == ("file_ready_unpublished", None) and p[0] == "activation_pending", "m=%s pub=%s" % (m, p)


def lc09(h):
    """failed publication rollback → mapped_verified（mapping_mode 保留）。"""
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
    e = h.query("SELECT mapping_status,pending_publication_id,candidate_source_selector,mapping_mode FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    assert e == ("mapped_verified", None, None, "publish_and_cutover"), "e=%s" % (e,)


def lc10(h):
    """rollback 后创建新 publication → 全链 PASS。"""
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
    h.mk_publication("PUB2", "legacy_cutover_publish", "E1", "publish_and_cutover")
    h.entry_to_mapping_pending("E1", "PUB2")
    h.pub_progress("PUB2")
    h.activate("PUB2", "ACT2")
    m = h.query("SELECT status,published_by_publication_id FROM voice_materializations WHERE id='M1'")[0]
    assert m == ("published_usable", "PUB2"), "m=%s" % (m,)


def lc11(h):
    """retired entry 不占活跃唯一位：新 entry 可映射同一 projection。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    h.exec("UPDATE legacy_adapter_voice_entries SET mapping_status='retired', retired_at=%s WHERE id='E1'" % q(iso(0)))
    h.mk_legacy_entry("E2", "legacy-key-2")
    h.entry_to_mapped_verified("E2", "M1", "publish_and_cutover")
    e2 = h.query("SELECT mapping_status,mapped_voice_materialization_id FROM legacy_adapter_voice_entries WHERE id='E2'")[0]
    e1 = h.query("SELECT mapping_status,mapped_voice_materialization_id FROM legacy_adapter_voice_entries WHERE id='E1'")[0]
    assert e2 == ("mapped_verified", "M1"), "e2=%s" % (e2,)
    assert e1 == ("retired", "M1"), "retired 历史 mapped ID 保留：e1=%s" % (e1,)


def lc12(h):
    """第二个活跃 legacy mapping 同 projection → ABORT。"""
    h.seed_base()
    h.mk_materialization("M1")
    h.mk_legacy_entry("E1")
    h.mk_legacy_entry("E2", "legacy-key-2")
    h.entry_to_mapped_verified("E1", "M1", "publish_and_cutover")
    ok, msg = h.expect_abort(
        """UPDATE legacy_adapter_voice_entries
        SET mapping_status='mapped_verified', mapped_voice_materialization_id='M1',
            mapping_mode='publish_and_cutover' WHERE id='E2'""",
        "alias to same projection forbidden")
    assert ok, msg


TESTS = [
    ("LC-01", "路径 A publish_and_cutover 全链 PASS", lc01),
    ("LC-02", "路径 B cutover_existing 全链 PASS（R9 P0-3 修复）", lc02),
    ("LC-03", "cutover_existing 不重写 projection publication evidence", lc03),
    ("LC-04", "情况1 mapped_verified 后普通 publish → blocked ABORT", lc04),
    ("LC-05", "情况2 publication 先完成后 cutover_existing 映射允许", lc05),
    ("LC-06", "情况3 在飞 publication + 映射竞争确定性裁决", lc06),
    ("LC-07", "错误 mapping_mode/subject_type 组合 → ABORT", lc07),
    ("LC-08", "activation 指向错误 entry 状态 → ABORT + 回滚", lc08),
    ("LC-09", "failed publication rollback → mapped_verified（mode 保留）", lc09),
    ("LC-10", "rollback 后新 publication → PASS", lc10),
    ("LC-11", "retired 不占活跃唯一位，新 entry 可再映射", lc11),
    ("LC-12", "第二个活跃 mapping 同 projection → ABORT", lc12),
]
