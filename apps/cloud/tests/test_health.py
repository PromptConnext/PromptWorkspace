def test_root(client):
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["service"] == "promptconnext-cloud"


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["backend"] == "memory"
    assert "time" in body
    # Ops surface (M7): schema version + in-process counters.
    assert body["schema_version"].startswith("0022")
    assert set(body["metrics"]) == {"pushed", "pulled", "merged", "conflicts"}
