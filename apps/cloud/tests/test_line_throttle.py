"""Discussion throttle: one LINE notice per node per window, and the next
notice summarises what the window held back (plan 0032)."""

from __future__ import annotations

from datetime import timedelta

from app.delivery.line_throttle import Burst, DiscussionThrottle
from app.models.schemas import utcnow

P, N = "p1", "n1"


def test_first_comment_passes_alone():
    assert DiscussionThrottle().allow(P, N, "bob", utcnow()) == Burst(1, ("bob",))


def test_comments_inside_the_window_are_held_then_summarised_by_the_next_send():
    throttle = DiscussionThrottle()
    t0 = utcnow()

    assert throttle.allow(P, N, "bob", t0) == Burst(1, ("bob",))
    assert throttle.allow(P, N, "ann", t0 + timedelta(minutes=1)) is None
    assert throttle.allow(P, N, "bob", t0 + timedelta(minutes=9, seconds=59)) is None
    # Comments 2-4: the two held back plus this one; authors distinct, in order.
    assert throttle.allow(P, N, "cid", t0 + timedelta(minutes=10)) == Burst(
        3, ("ann", "bob", "cid"))
    # The window restarts at that send, with nothing held.
    assert throttle.allow(P, N, "bob", t0 + timedelta(minutes=19)) is None
    assert throttle.allow(P, N, "bob", t0 + timedelta(minutes=20)) == Burst(2, ("bob",))


def test_held_comments_wait_for_the_next_comment_however_late():
    throttle = DiscussionThrottle()
    t0 = utcnow()
    throttle.allow(P, N, "bob", t0)
    throttle.allow(P, N, "ann", t0 + timedelta(minutes=1))

    assert throttle.allow(P, N, "bob", t0 + timedelta(days=2)) == Burst(2, ("ann", "bob"))


def test_nodes_are_throttled_separately():
    throttle = DiscussionThrottle()
    t0 = utcnow()

    assert throttle.allow(P, "a", "bob", t0)
    assert throttle.allow(P, "b", "bob", t0)
    assert throttle.allow("p2", "a", "bob", t0)
