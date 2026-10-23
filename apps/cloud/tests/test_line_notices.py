"""LINE notification copy, English and Thai (plan 0032 task 3). Pure."""

from __future__ import annotations

from app.delivery import line_notices as ln

H = "[PromptWorkspace] Acme"
L = "https://app.example/x"


def test_requested():
    en = ln.requested("Acme", "intent_approval", "a@x.com", "business_owner", L, "en")
    assert en == (
        f"{H}\nIntent approval is waiting for a@x.com (business owner).\nDecide here: {L}"
    )
    th = ln.requested("Acme", "plan_approval", "a@x.com", "tech_steward", L, "th")
    assert th == (
        f"{H}\nการอนุมัติแผนงาน รอ a@x.com (ผู้ดูแลด้านเทคนิค) ตัดสินใจ\nตัดสินใจที่นี่: {L}"
    )
    en2 = ln.requested("Acme", "plan_approval", "a@x.com", "tech_steward", L, "en")
    assert "Plan approval is waiting for a@x.com (tech steward)." in en2
    th2 = ln.requested("Acme", "intent_approval", "a@x.com", "business_owner", L, "th")
    assert "การอนุมัติความต้องการ รอ a@x.com (เจ้าของงานฝั่งธุรกิจ) ตัดสินใจ" in th2


def test_no_holder_uses_any_admin_phrase():
    en = ln.requested("Acme", "intent_approval", None, "business_owner", L, "en")
    assert en == f"{H}\nIntent approval is waiting for any workspace admin.\nDecide here: {L}"
    th = ln.requested("Acme", "plan_approval", None, "tech_steward", L, "th")
    assert th == (
        f"{H}\nการอนุมัติแผนงาน รอผู้ดูแลเวิร์กสเปซคนใดก็ได้ตัดสินใจ\nตัดสินใจที่นี่: {L}"
    )


def test_changes_requested():
    en = ln.changes_requested("Acme", "plan_approval", "b@x.com", "Too vague", L, "en")
    assert en == (
        f"{H}\nb@x.com requested changes on the plan.\nReason: Too vague\nReview: {L}"
    )
    th = ln.changes_requested("Acme", "intent_approval", "b@x.com", "Too vague", L, "th")
    assert th == (
        f"{H}\nb@x.com ขอให้แก้ไขความต้องการ\nเหตุผล: Too vague\nดูรายละเอียด: {L}"
    )
    en2 = ln.changes_requested("Acme", "intent_approval", "b@x.com", "", L, "en")
    assert "Reason: No reason was given." in en2 and "on the intent." in en2
    th2 = ln.changes_requested("Acme", "plan_approval", "b@x.com", None, L, "th")
    assert "เหตุผล: ไม่ได้ระบุเหตุผล" in th2 and "ขอให้แก้ไขแผนงาน" in th2


def test_approved():
    assert ln.approved("Acme", "intent_approval", "b@x.com", L, "en") == (
        f"{H}\nb@x.com approved the intent.\nOpen: {L}"
    )
    assert ln.approved("Acme", "plan_approval", "b@x.com", L, "th") == (
        f"{H}\nb@x.com อนุมัติแผนงานแล้ว\nเปิดดู: {L}"
    )
    assert "approved the plan." in ln.approved("Acme", "plan_approval", "b", L, "en")
    assert "อนุมัติความต้องการแล้ว" in ln.approved("Acme", "intent_approval", "b", L, "th")


def test_reminder():
    assert ln.reminder("Acme", "intent_approval", "a@x.com", "business_owner", L, "en") == (
        f"{H}\nReminder: Intent approval is still waiting for a@x.com and expires soon.\n"
        f"Decide here: {L}"
    )
    assert ln.reminder("Acme", "plan_approval", "a@x.com", "tech_steward", L, "th") == (
        f"{H}\nเตือน: การอนุมัติแผนงาน ยังรอ a@x.com ตัดสินใจ และจะหมดอายุเร็วๆ นี้\n"
        f"ตัดสินใจที่นี่: {L}"
    )
    assert "Reminder: Plan approval is" in ln.reminder(
        "Acme", "plan_approval", "a", "tech_steward", L, "en"
    )
    assert "เตือน: การอนุมัติความต้องการ ยังรอ" in ln.reminder(
        "Acme", "intent_approval", "a", "business_owner", L, "th"
    )


def test_expired():
    assert ln.expired("Acme", "intent_approval", L, "en") == (
        f"{H}\nNobody answered the intent approval in time, so it counts as not approved.\n"
        f"Ask again: {L}"
    )
    assert ln.expired("Acme", "plan_approval", L, "th") == (
        f"{H}\nไม่มีผู้ตัดสินใจการอนุมัติแผนงานทันเวลา จึงถือว่าไม่อนุมัติ\n"
        f"ส่งขออนุมัติใหม่: {L}"
    )
    assert "the plan approval in time" in ln.expired("Acme", "plan_approval", L, "en")
    assert "ตัดสินใจการอนุมัติความต้องการทันเวลา" in ln.expired(
        "Acme", "intent_approval", L, "th"
    )


def test_ready_to_verify():
    assert ln.ready_to_verify("Acme", "T-12", "Login page", L, "en") == (
        f"{H}\nT-12 Login page is implemented and ready to verify.\nVerify: {L}"
    )
    assert ln.ready_to_verify("Acme", "T-12", "Login page", L, "th") == (
        f"{H}\nT-12 Login page ทำเสร็จแล้ว รอการตรวจรับ\nตรวจรับที่นี่: {L}"
    )


def test_ready_to_verify_cuts_long_titles():
    out = ln.ready_to_verify("Acme", "T-1", "x" * 200, L, "en")
    title = out.split("\n")[1].split(" ")[1]
    assert len(title) == 80 and title.endswith("…")


def test_discussion():
    assert ln.discussion("Acme", "Bo", "T-12 Login page", L, "en") == (
        f"{H}\nBo commented on T-12 Login page. Someone may need to answer.\nOpen: {L}"
    )
    assert ln.discussion("Acme", "Bo", "แผนงาน", L, "th") == (
        f"{H}\nBo แสดงความคิดเห็นในแผนงาน อาจมีคำถามที่ต้องการคำตอบ\nเปิดดู: {L}"
    )


def test_about_labels():
    assert ln.about_label("task", "T-1", "Hi", "en") == "T-1 Hi"
    assert ln.about_label("task", "T-1", "Hi", "th") == "T-1 Hi"
    assert ln.about_label("spec", None, None, "en") == "the specification"
    assert ln.about_label("spec", None, None, "th") == "ข้อกำหนด"
    assert ln.about_label("plan", None, None, "en") == "the plan"
    assert ln.about_label("plan", None, None, "th") == "แผนงาน"
    assert ln.about_label("other", None, None, "en") == "the project"
    assert ln.about_label(None, None, None, "th") == "โปรเจกต์"


def test_linked():
    assert ln.linked("Acme", "en") == (
        "Linked to Acme. This group will get PromptWorkspace notifications for it."
    )
    assert ln.linked("Acme", "th") == (
        "เชื่อมกลุ่มนี้กับโปรเจกต์ Acme แล้ว "
        "กลุ่มนี้จะได้รับการแจ้งเตือนจาก PromptWorkspace สำหรับโปรเจกต์นี้"
    )


def test_line_test_message():
    assert ln.line_test_message("Acme", "en") == (
        f"{H}\nTest message. LINE notifications for this project are working."
    )
    assert ln.line_test_message("Acme", "th") == (
        f"{H}\nข้อความทดสอบ การแจ้งเตือนผ่าน LINE ของโปรเจกต์นี้ใช้งานได้"
    )


def test_reason_is_capped_at_200_characters():
    for lang in ("en", "th"):
        out = ln.changes_requested("Acme", "plan_approval", "b", "y" * 500, L, lang)
        reason = out.split("\n")[2].split(": ", 1)[1]
        assert len(reason) == 200 and reason.endswith("…")
    short = ln.changes_requested("Acme", "plan_approval", "b", "y" * 200, L, "en")
    assert "y" * 200 in short and "…" not in short


def test_newlines_in_names_are_flattened():
    out = ln.requested("Ac\r\nme\n", "intent_approval", "a\nb@x.com", "business_owner", L, "en")
    assert out.split("\n")[0] == "[PromptWorkspace] Ac  me"
    assert "a b@x.com" in out
    assert len(out.split("\n")) == 3
    r = ln.changes_requested("Acme", "plan_approval", "b", "line1\nline2\r\n", L, "en")
    assert "Reason: line1 line2" in r and len(r.split("\n")) == 4


def test_reminder_no_holder_uses_any_admin_phrase():
    en = ln.reminder("Acme", "plan_approval", None, "tech_steward", L, "en")
    assert en == (
        f"{H}\nReminder: Plan approval is still waiting for any workspace admin "
        f"and expires soon.\nDecide here: {L}"
    )
    th = ln.reminder("Acme", "intent_approval", None, "business_owner", L, "th")
    assert th == (
        f"{H}\nเตือน: การอนุมัติความต้องการ ยังรอผู้ดูแลเวิร์กสเปซคนใดก็ได้ตัดสินใจ "
        f"และจะหมดอายุเร็วๆ นี้\nตัดสินใจที่นี่: {L}"
    )
