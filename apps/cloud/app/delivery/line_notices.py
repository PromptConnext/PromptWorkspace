"""What LINE decision notices say, in English and Thai (plan 0032). Pure.

A message names the decision, the project and where to answer it; it never
carries document text or a discussion body, which may hold personal data."""

from __future__ import annotations

from typing import Literal

Lang = Literal["en", "th"]

_PREFIX = "[PromptWorkspace]"
_TITLE_CAP = 80
_REASON_CAP = 200

_KIND_EN = {"intent_approval": "intent", "plan_approval": "plan"}
_KIND_TH = {"intent_approval": "ความต้องการ", "plan_approval": "แผนงาน"}
_APPROVAL_EN = {"intent_approval": "Intent approval", "plan_approval": "Plan approval"}
_APPROVAL_TH = {
    "intent_approval": "การอนุมัติความต้องการ",
    "plan_approval": "การอนุมัติแผนงาน",
}
_HAT_EN = {"business_owner": "business owner", "tech_steward": "tech steward"}
_HAT_TH = {"business_owner": "เจ้าของงานฝั่งธุรกิจ", "tech_steward": "ผู้ดูแลด้านเทคนิค"}


def _v(text: str | None, cap: int | None = None) -> str:
    """One interpolated value: CR/LF flattened to a space, trimmed, and cut with
    an ellipsis so the result never exceeds `cap`."""
    out = (text or "").replace("\r", " ").replace("\n", " ").strip()
    if cap is not None and len(out) > cap:
        out = out[: cap - 1].rstrip() + "…"
    return out


def _msg(project: str, *lines: str) -> str:
    return "\n".join([f"{_PREFIX} {_v(project)}", *lines])


def about_label(
    kind: str | None, ref: str | None, title: str | None, lang: Lang
) -> str:
    """What a discussion is about: a task, the specification, the plan, or the project."""
    if kind == "task":
        return f"{_v(ref)} {_v(title, _TITLE_CAP)}".strip()
    if kind == "spec":
        return "the specification" if lang == "en" else "ข้อกำหนด"
    if kind == "plan":
        return "the plan" if lang == "en" else "แผนงาน"
    return "the project" if lang == "en" else "โปรเจกต์"


def requested(
    project: str, kind: str, who: str | None, hat: str, link: str, lang: Lang
) -> str:
    holder = _v(who)
    if lang == "th":
        label = _APPROVAL_TH[kind]
        if holder:
            first = f"{label} รอ {holder} ({_HAT_TH[hat]}) ตัดสินใจ"
        else:
            first = f"{label} รอผู้ดูแลเวิร์กสเปซคนใดก็ได้ตัดสินใจ"
        return _msg(project, first, f"ตัดสินใจที่นี่: {_v(link)}")
    label = _APPROVAL_EN[kind]
    if holder:
        first = f"{label} is waiting for {holder} ({_HAT_EN[hat]})."
    else:
        first = f"{label} is waiting for any workspace admin."
    return _msg(project, first, f"Decide here: {_v(link)}")


def changes_requested(
    project: str, kind: str, resolver: str, reason: str | None, link: str, lang: Lang
) -> str:
    why = _v(reason, _REASON_CAP)
    if lang == "th":
        return _msg(
            project,
            f"{_v(resolver)} ขอให้แก้ไข{_KIND_TH[kind]}",
            f"เหตุผล: {why or 'ไม่ได้ระบุเหตุผล'}",
            f"ดูรายละเอียด: {_v(link)}",
        )
    return _msg(
        project,
        f"{_v(resolver)} requested changes on the {_KIND_EN[kind]}.",
        f"Reason: {why or 'No reason was given.'}",
        f"Review: {_v(link)}",
    )


def approved(project: str, kind: str, resolver: str, link: str, lang: Lang) -> str:
    if lang == "th":
        return _msg(
            project, f"{_v(resolver)} อนุมัติ{_KIND_TH[kind]}แล้ว", f"เปิดดู: {_v(link)}"
        )
    return _msg(
        project, f"{_v(resolver)} approved the {_KIND_EN[kind]}.", f"Open: {_v(link)}"
    )


def reminder(
    project: str, kind: str, who: str | None, hat: str, link: str, lang: Lang
) -> str:
    holder = _v(who)
    if lang == "th":
        return _msg(
            project,
            f"เตือน: {_APPROVAL_TH[kind]} ยังรอ {holder} ตัดสินใจ และจะหมดอายุเร็วๆ นี้",
            f"ตัดสินใจที่นี่: {_v(link)}",
        )
    return _msg(
        project,
        f"Reminder: {_APPROVAL_EN[kind]} is still waiting for {holder} and expires soon.",
        f"Decide here: {_v(link)}",
    )


def expired(project: str, kind: str, link: str, lang: Lang) -> str:
    if lang == "th":
        return _msg(
            project,
            f"ไม่มีผู้ตัดสินใจ{_APPROVAL_TH[kind]}ทันเวลา จึงถือว่าไม่อนุมัติ",
            f"ส่งขออนุมัติใหม่: {_v(link)}",
        )
    return _msg(
        project,
        f"Nobody answered the {_KIND_EN[kind]} approval in time, so it counts as not approved.",
        f"Ask again: {_v(link)}",
    )


def ready_to_verify(project: str, ref: str, title: str, link: str, lang: Lang) -> str:
    task = f"{_v(ref)} {_v(title, _TITLE_CAP)}"
    if lang == "th":
        return _msg(project, f"{task} ทำเสร็จแล้ว รอการตรวจรับ", f"ตรวจรับที่นี่: {_v(link)}")
    return _msg(
        project, f"{task} is implemented and ready to verify.", f"Verify: {_v(link)}"
    )


def discussion(project: str, author: str, about: str, link: str, lang: Lang) -> str:
    if lang == "th":
        return _msg(
            project,
            f"{_v(author)} แสดงความคิดเห็นใน{_v(about)} อาจมีคำถามที่ต้องการคำตอบ",
            f"เปิดดู: {_v(link)}",
        )
    return _msg(
        project,
        f"{_v(author)} commented on {_v(about)}. Someone may need to answer.",
        f"Open: {_v(link)}",
    )


def linked(project: str, lang: Lang) -> str:
    name = _v(project)
    if lang == "th":
        return (
            f"เชื่อมกลุ่มนี้กับโปรเจกต์ {name} แล้ว "
            "กลุ่มนี้จะได้รับการแจ้งเตือนจาก PromptWorkspace สำหรับโปรเจกต์นี้"
        )
    return f"Linked to {name}. This group will get PromptWorkspace notifications for it."


def test_message(project: str, lang: Lang) -> str:
    if lang == "th":
        return _msg(project, "ข้อความทดสอบ การแจ้งเตือนผ่าน LINE ของโปรเจกต์นี้ใช้งานได้")
    return _msg(project, "Test message. LINE notifications for this project are working.")
