"""Direct reducer and view checks for the local classroom database."""

import json
from uuid import uuid4

import httpx
import pytest

from app.classroom.owner import load_owner
from app.config import get_settings

OWNER = load_owner(get_settings())
if OWNER is None:
    pytest.skip("classroom owner file is not configured", allow_module_level=True)


def _call(token: str, reducer: str, args: list) -> httpx.Response:
    return httpx.post(
        f"{OWNER['uri'].rstrip('/')}/v1/database/{OWNER['database']}/call/{reducer}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        content=json.dumps(args),
        timeout=20,
    )


def _sql(token: str, query: str) -> httpx.Response:
    return httpx.post(
        f"{OWNER['uri'].rstrip('/')}/v1/database/{OWNER['database']}/sql",
        headers={"Authorization": f"Bearer {token}"},
        content=query.encode(),
        timeout=20,
    )


def _identity() -> str:
    response = httpx.post(f"{OWNER['uri'].rstrip('/')}/v1/identity", timeout=20)
    assert response.status_code < 300
    return response.json()["token"]


def _settings(target: str = "u") -> str:
    return json.dumps({
        "target": target,
        "context": "sound",
        "cueId": "round-lips",
        "assistance": "cue-target",
        "referenceReplay": False,
        "repetitions": 2,
        "note": "",
    })


def test_stranger_cannot_mint_save_or_read_private_rows():
    stranger = _identity()
    minted = _call(stranger, "mint_invite", ["cd" * 16, "teacher", "teacher-stranger", "room-z", "Stranger"])
    # This server returns HTTP 530 with a generic body. The module log records "backend only".
    assert minted.status_code >= 400
    saved = _call(stranger, "save_lesson", [str(uuid4()), "learner", "room-1-learner-lea", "room-1", 0, _settings(), 0])
    assert saved.status_code >= 400
    private = _sql(stranger, "SELECT * FROM class_invite")
    assert private.status_code >= 400
    board = _sql(stranger, "SELECT * FROM classroom_board")
    assert board.status_code < 300
    assert "teacher-stranger" not in board.text


def test_isolated_lesson_ack_and_synthetic_repeat():
    suffix = uuid4().hex[:8]
    room = f"r{suffix}"
    other_room = f"q{suffix}"
    teacher_id, learner_a, learner_b = f"{room}-t", f"{room}-a", f"{room}-b"
    teacher, learner, other = _identity(), _identity(), _identity()
    outsider = _identity()
    code_t, code_a, code_b, code_o = (uuid4().hex for _ in range(4))
    assert _call(OWNER["token"], "mint_invite", [code_t, "teacher", teacher_id, room, "Auth"]).status_code < 300
    assert _call(teacher, "accept_invite", [code_t]).status_code < 300
    assert _call(OWNER["token"], "mint_invite", [code_a, "learner", learner_a, room, "A"]).status_code < 300
    assert _call(learner, "accept_invite", [code_a]).status_code < 300
    assert _call(OWNER["token"], "mint_invite", [code_b, "learner", learner_b, room, "B"]).status_code < 300
    assert _call(other, "accept_invite", [code_b]).status_code < 300
    assert _call(OWNER["token"], "mint_invite", [code_o, "teacher", f"{other_room}-t", other_room, "Other"]).status_code < 300
    assert _call(outsider, "accept_invite", [code_o]).status_code < 300

    command = str(uuid4())
    first = _call(teacher, "save_lesson", [command, "learner", learner_a, room, 0, _settings("u"), 0])
    assert first.status_code < 300, first.text[:180]
    assert _call(teacher, "save_lesson", [command, "learner", learner_a, room, 0, _settings("u"), 0]).status_code < 300
    clash = _call(teacher, "save_lesson", [str(uuid4()), "learner", learner_a, room, 0, _settings("a"), 0])
    assert clash.status_code >= 400
    own = _sql(learner, "SELECT * FROM my_classroom_lesson")
    assert own.status_code < 300 and learner_a in own.text and "Target u." in own.text
    other_view = _sql(other, "SELECT * FROM my_classroom_lesson")
    assert learner_a not in other_view.text
    assert _sql(learner, "SELECT * FROM classroom_board").status_code < 300
    assert learner_b not in _sql(learner, "SELECT * FROM classroom_board").text
    assert _call(learner, "save_lesson", [str(uuid4()), "learner", learner_b, room, 0, _settings(), 0]).status_code >= 400
    assert learner_a not in _sql(outsider, "SELECT * FROM classroom_board").text

    assert _call(learner, "ack_lesson", [99, "applied", command]).status_code >= 400
    assert _call(learner, "ack_lesson", [1, "received", command]).status_code < 300
    assert _call(learner, "ack_lesson", [1, "applied", command]).status_code < 300
    assert _call(learner, "ack_lesson", [1, "applied", command]).status_code < 300
    second = str(uuid4())
    assert _call(teacher, "save_lesson", [second, "learner", learner_a, room, 1, _settings("a"), 0]).status_code < 300
    assert _call(learner, "ack_lesson", [1, "applied", command]).status_code >= 400
    current = _sql(learner, "SELECT * FROM my_classroom_lesson")
    assert "Target u -> a." in current.text and "pending" in current.text

    assert _call(OWNER["token"], "commit_verified_summary", [
        learner_a, str(uuid4()), "a", True, "mouth_more_open", "synthetic",
        "synthetic-fixture", "synthetic", "mouth_more_open", "{}", True,
    ]).status_code < 300
    roll = _sql(OWNER["token"], f"SELECT * FROM learner_roll WHERE profile_id = '{learner_a}'")
    assert roll.status_code < 300
    body = roll.text
    assert "mouth_more_open" in body
