def test_root(client):
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["service"] == "promptzone-cloud"


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["backend"] == "memory"
    assert "time" in body
