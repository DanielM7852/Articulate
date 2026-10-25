"""Quiz difficulty. The model is a fake client and cannot raise the ceiling."""

from fastapi.testclient import TestClient

from app.main import create_app
from app.reasoning.lesson_difficulty import DifficultyChoice
from tests.support import make_settings


def _prefs(**overrides):
    body = {
        "goals": ["sounds"],
        "routine": "occasional",
        "pace": "steady",
        "support": "words",
        "guidance": "guided",
    }
    body.update(overrides)
    return body


def test_quiz_answers_choose_different_starting_difficulties(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    gentle = client.post(
        "/v1/lesson-plan",
        json={
            "sound": "u",
            "preferences": _prefs(
                goals=["visual", "longer"],
                routine="exploring",
                pace="unhurried",
                support="mouth",
                guidance="guided",
            ),
        },
    )
    assert gentle.status_code == 200
    assert gentle.json()["source"] == "local"
    assert gentle.json()["difficulty"] == "gentle"
    assert gentle.json()["plan"] == {"sound": "u", "pace": "unhurried", "assistance": "cue-target"}

    supported = client.post(
        "/v1/lesson-plan",
        json={"preferences": _prefs(guidance="explore", support="mouth", pace="steady", goals=["sounds"])},
    )
    assert supported.json()["difficulty"] == "supported"
    assert supported.json()["plan"]["assistance"] == "cue-target"
    assert supported.json()["plan"]["pace"] == "steady"

    opened = client.post(
        "/v1/lesson-plan",
        json={
            "preferences": _prefs(
                goals=["conversations"],
                routine="regular",
                pace="flexible",
                support="self",
                guidance="explore",
            )
        },
    )
    assert opened.json()["difficulty"] == "open"
    assert opened.json()["plan"]["assistance"] == "target-only"
    assert opened.json()["plan"]["pace"] == "flexible"


def test_claude_can_lower_the_quiz_plan_but_not_raise_it(tmp_path):
    class _Messages:
        def __init__(self, difficulty):
            self.difficulty = difficulty

        def parse(self, **_kwargs):
            return type("Parsed", (), {"parsed_output": DifficultyChoice(difficulty=self.difficulty)})()

    class _Client:
        def __init__(self, difficulty):
            self.messages = _Messages(difficulty)

    app = create_app(make_settings(tmp_path, anthropic_api_key="sk-test"))
    client = TestClient(app)
    app.state.vowel_client = _Client("gentle")
    lowered = client.post(
        "/v1/lesson-plan",
        json={
            "preferences": _prefs(
                goals=["conversations"],
                routine="regular",
                pace="flexible",
                support="self",
                guidance="explore",
            )
        },
    )
    assert lowered.json()["source"] == "agent"
    assert lowered.json()["difficulty"] == "gentle"
    assert lowered.json()["plan"]["assistance"] == "cue-target"

    app.state.vowel_client = _Client("open")
    held = client.post(
        "/v1/lesson-plan",
        json={
            "sound": "a",
            "preferences": _prefs(
                goals=["visual"],
                routine="exploring",
                pace="unhurried",
                support="mouth",
                guidance="guided",
            ),
        },
    )
    assert held.json()["difficulty"] == "gentle"
    assert held.json()["plan"]["sound"] == "a"
    assert held.json()["plan"]["assistance"] == "cue-target"


def test_easier_goals_do_not_remove_cues_after_one_usable_take(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    response = client.post(
        "/v1/coach",
        json={
            "attempt": {
                "attemptId": "attempt-1",
                "sound": "i",
                "kind": "guided",
                "assistance": "cue-target",
                "startedAt": 1,
                "durationSec": 3.2,
                "usableVoicedSec": 2.4,
                "quality": "usable",
                "recognizedText": None,
            },
            "history": [],
            "plan": {"sound": "i", "pace": "unhurried", "assistance": "cue-target"},
            "preferences": _prefs(goals=["visual", "longer"], routine="exploring", pace="unhurried", support="mouth"),
        },
    )
    assert response.status_code == 200
    assert response.json()["nextAction"] == "repeat"
    assert response.json()["plan"]["assistance"] == "cue-target"
