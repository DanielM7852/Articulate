from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app


def until(ws, kind):
    for _ in range(500):
        item = ws.receive_json()
        if item["type"] == "error":
            raise AssertionError(item)
        if item["type"] == kind:
            return item
    raise AssertionError(f"missing {kind}")


def test_full_fixture_websocket_audio_and_authorization(settings):
    settings.provider_deadline_seconds = 3
    app = create_app(settings)
    with TestClient(app) as http:
        assert http.get("/health/live").status_code == 200
        assert http.get("/health/ready").json()["mock_mode"]
        c = http.post("/api/sessions").json()
        sid, token = c["session_id"], c["capability"]
        headers = {"Authorization": f"Bearer {token}"}
        assert http.get(f"/api/sessions/{sid}/snapshot").status_code == 404
        other = http.post("/api/sessions").json()
        assert (
            http.get(
                f"/api/sessions/{sid}/snapshot", headers={"Authorization": f"Bearer {other['capability']}"}
            ).status_code
            == 404
        )
        with http.websocket_connect(c["events_url"]) as ws, http.websocket_connect(c["audio_url"]) as audio:
            ws.send_json({"capability": token})
            assert ws.receive_json()["type"] == "snapshot"
            audio.send_json({"capability": token})
            audio.send_json({"encoding": "pcm_s16le", "channels": 1})
            assert audio.receive_json()["type"] == "audio.ready"
            revision = 0

            def send(payload):
                nonlocal revision
                ws.send_json({"command_id": str(uuid4()), "expected_revision": revision, "payload": payload})
                ack = until(ws, "command.ack")
                revision = ack["payload"]["revision"]

            send({"type": "session.configure", "target_id": "i", "audio_enabled": True})
            send({"type": "attempt.start", "source": "synthetic"})
            for _ in range(12):
                until(ws, "features.frame")
            send({"type": "attempt.end", "final_sample": 0})
            decision = until(ws, "coach.decision")
            assert decision["payload"]["caption"] and decision["payload"]["pose_id"] == "vowel-i"
            assert audio.receive_json()["type"] == "audio.start"
            assert len(audio.receive_bytes()) > 44
            end = until(ws, "audio.end")
            key = end["payload"]["cache_key"]
            assert http.get(f"/api/audio/{key}?session_id={sid}", headers=headers).status_code == 200
            assert (
                http.get(
                    f"/api/audio/{key}?session_id={other['session_id']}",
                    headers={"Authorization": f"Bearer {other['capability']}"},
                ).status_code
                == 404
            )
            snap = http.get(f"/api/sessions/{sid}/snapshot", headers=headers).json()
            assert len(snap["history"]) == 1 and snap["pending_sync"] > 0
        assert http.post("/api/sessions", headers={"Origin": "https://evil.example"}).status_code == 403


def test_reconnect_restores_history_without_stale_audio(settings):
    app = create_app(settings)
    with TestClient(app) as http:
        c = http.post("/api/sessions").json()
        headers = {"Authorization": f"Bearer {c['capability']}"}
        with http.websocket_connect(c["events_url"]) as ws:
            ws.send_json({"capability": c["capability"]})
            ws.receive_json()
            ws.send_json(
                {
                    "command_id": str(uuid4()),
                    "expected_revision": 0,
                    "payload": {"type": "attempt.start", "source": "synthetic"},
                }
            )
            until(ws, "command.ack")
    with TestClient(create_app(settings)) as http:
        snap = http.get(f"/api/sessions/{c['session_id']}/snapshot", headers=headers).json()
        assert snap["session"]["state"] == "ready" and snap["generation_id"] is None
        assert snap["session"]["revision"] > 0 and snap["pending_sync"] > 0


def test_invalid_audio_negotiation_and_wrong_capability(settings):
    with TestClient(create_app(settings)) as http:
        c = http.post("/api/sessions").json()
        with pytest.raises(WebSocketDisconnect):
            with http.websocket_connect(c["events_url"]) as ws:
                ws.send_json({"capability": "wrong"})
                ws.receive_json()
        with pytest.raises(WebSocketDisconnect):
            with http.websocket_connect(c["audio_url"]) as ws:
                ws.send_json({"capability": c["capability"]})
                ws.send_json({"encoding": "mp3", "channels": 2})
                ws.receive_json()


def test_malformed_audio_text_rejected_and_can_reconnect(settings):
    with TestClient(create_app(settings)) as http:
        c = http.post("/api/sessions").json()
        with pytest.raises(WebSocketDisconnect):
            with http.websocket_connect(c["audio_url"]) as ws:
                ws.send_json({"capability": c["capability"]})
                ws.send_json({"encoding": "pcm_s16le", "channels": 1})
                ws.receive_json()
                ws.send_text("not binary pcm")
                ws.receive_json()
        with http.websocket_connect(c["audio_url"]) as ws:
            ws.send_json({"capability": c["capability"]})
            ws.send_json({"encoding": "pcm_s16le", "channels": 1})
            assert ws.receive_json()["type"] == "audio.ready"


def test_observers_share_controller_and_duplicate_commands_do_not_restart(settings):
    with TestClient(create_app(settings)) as http:
        c = http.post("/api/sessions").json()
        headers = {"Authorization": f"Bearer {c['capability']}"}
        with (
            http.websocket_connect(c["events_url"]) as learner,
            http.websocket_connect(c["events_url"]) as observer,
        ):
            for ws in (learner, observer):
                ws.send_json({"capability": c["capability"]})
                ws.receive_json()
            cmd = {
                "command_id": str(uuid4()),
                "expected_revision": 0,
                "payload": {"type": "attempt.start", "source": "synthetic"},
            }
            learner.send_json(cmd)
            first = until(learner, "command.ack")
            seen = until(observer, "command.ack")
            assert seen["attempt_id"] == first["attempt_id"]
            observer.send_json(cmd)
            duplicate = until(observer, "command.ack")
            assert duplicate["attempt_id"] == first["attempt_id"]
            observer.send_json(
                {"command_id": str(uuid4()), "expected_revision": 1, "payload": {"type": "session.pause"}}
            )
            until(observer, "command.ack")
            snap = http.get(f"/api/sessions/{c['session_id']}/snapshot", headers=headers).json()
            assert snap["session"]["state"] == "paused" and snap["session"]["revision"] == 2
        assert (
            http.get(f"/api/sessions/{c['session_id']}/snapshot", headers=headers).json()["session"]["state"]
            == "paused"
        )
