import re


def test_root(client):
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["service"] == "promptworkspace-cloud"


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["backend"] == "memory"
    assert "time" in body
    # Ops surface (M7): schema version + in-process counters.
    #
    # Asserts the *shape*, not a specific number. This previously pinned a
    # literal migration prefix, which meant every migration broke a test that
    # was only ever checking that /health reports one at all.
    assert re.fullmatch(r"\d{4}_[a-z0-9_]+", body["schema_version"])
    assert set(body["metrics"]) == {"pushed", "pulled", "merged", "conflicts"}
