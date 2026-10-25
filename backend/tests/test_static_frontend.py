"""Single-container hosting: the built frontend is served at / without shadowing the API."""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings

INDEX = "<!doctype html><title>Articulate app</title>"


def _dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX, encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (dist / "mediapipe").mkdir()
    (dist / "mediapipe" / "vision.wasm").write_bytes(b"\0asm")
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    return dist


def test_static_dir_serves_index_assets_and_keeps_api(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path, static_dir=str(_dist(tmp_path)))))

    page = client.get("/")
    assert page.status_code == 200
    assert page.text == INDEX
    assert page.headers["content-type"].startswith("text/html")
    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert "javascript" in asset.headers["content-type"]
    assert client.get("/mediapipe/vision.wasm").headers["content-type"] == "application/wasm"
    # Unknown app paths fall back to index.html; missing asset files stay 404.
    assert client.get("/dashboard").text == INDEX
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/../secret.txt").status_code == 404
    assert client.get("/%2e%2e/secret.txt").status_code == 404

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["audio_retained_by_default"] is False
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200
    # API misses keep their JSON 404 and method errors instead of returning the app shell.
    missing = client.get("/v1/does-not-exist")
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Not Found"}
    assert client.get("/v1/references/nope").status_code == 404
    assert client.get("/v1/coach").status_code == 405
    assert client.post("/dashboard").status_code == 404
    assert client.get("/health/nope").status_code == 404


def test_without_static_dir_root_stays_listening_check(tmp_path):
    for settings in (make_settings(tmp_path), make_settings(tmp_path, static_dir=str(tmp_path / "absent"))):
        client = TestClient(create_app(settings))
        page = client.get("/")
        assert page.status_code == 200
        assert "Listening check" in page.text
        assert client.get("/dashboard").status_code == 404
        assert client.get("/health").status_code == 200
