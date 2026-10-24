"""Practice-screen coach contract. The agent case uses a fake Claude client."""

from fastapi.testclient import TestClient

from app.main import create_app
from app.reasoning.vowel_coach import VowelPhrasing
from tests.support import make_settings


def _plan(**overrides):
    body = {"sound": "i", "pace": "unhurried", "assistance": "cue-target"}
    body.update(overrides)
    return body


def _attempt(**overrides):
    body = {
        "attemptId": "attempt-1",
        "sound": "i",
        "kind": "guided",
        "assistance": "cue-target",
        "startedAt": 1,
        "durationSec": 3.2,
        "usableVoicedSec": 2.4,
        "timeInTargetSec": None,
        "longestHoldSec": None,
        "quality": "usable",
        "recognizedText": None,
    }
    body.update(overrides)
    return body


def test_coach_uses_the_screen_wording_without_a_model(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    response = client.post("/v1/coach", json={"attempt": _attempt(), "history": []})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "local"
    assert body["nextAction"] == "reduce-assistance"
    assert body["evidence"] == ["usable_voiced=2.4s"]
    assert "2.4" in body["observation"]
    assert "ee" in body["observation"]
    unclear = client.post(
        "/v1/coach",
        json={"attempt": _attempt(quality="unclear", qualityReason="silence", usableVoicedSec=0.1), "history": []},
    )
    assert unclear.json()["nextAction"] == "repair-capture"
    assert unclear.json()["evidence"] == ["quality=silence"]


def test_coach_keeps_server_evidence_when_the_model_phrases_the_observation(tmp_path):
    class _Messages:
        def parse(self, **_kwargs):
            return type("Parsed", (), {"parsed_output": VowelPhrasing(observation="Usable voice for ee lasted 2.4 seconds.")})()

    class _Client:
        messages = _Messages()

    app = create_app(make_settings(tmp_path, anthropic_api_key="sk-test"))
    app.state.vowel_client = _Client()
    response = TestClient(app).post("/v1/coach", json={"attempt": _attempt(), "history": []})
    body = response.json()
    assert body["source"] == "agent"
    assert body["observation"] == "Usable voice for ee lasted 2.4 seconds."
    assert body["evidence"] == ["usable_voiced=2.4s"]
    assert body["nextAction"] == "reduce-assistance"


def test_coach_rejects_an_observation_that_adds_a_measurement(tmp_path):
    class _Messages:
        def parse(self, **_kwargs):
            return type("Parsed", (), {"parsed_output": VowelPhrasing(observation="The trace spent 9.9 seconds in range.")})()

    class _Client:
        messages = _Messages()

    app = create_app(make_settings(tmp_path, anthropic_api_key="sk-test"))
    app.state.vowel_client = _Client()
    response = TestClient(app).post("/v1/coach", json={"attempt": _attempt(), "history": []})
    body = response.json()
    assert body["source"] == "local"
    assert "9.9" not in body["observation"]


def test_progress_is_personal_and_a_repeated_attempt_does_not_count_twice(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    first = _attempt(attemptId="attempt-a", usableVoicedSec=1.0)
    saved = client.post(
        "/v1/coach",
        json={"attempt": first, "history": [], "learnerId": "a@example.com", "plan": _plan()},
    )
    assert saved.status_code == 200
    assert saved.json()["plan"]["sound"] == "i"
    assert saved.json()["nextAction"] == "repeat"
    again = client.post(
        "/v1/coach",
        json={"attempt": first, "history": [], "learnerId": "a@example.com", "plan": _plan()},
    )
    assert again.json()["plan"]["assistance"] == "cue-target"
    other = client.post(
        "/v1/coach",
        json={
            "attempt": _attempt(attemptId="attempt-b", sound="u"),
            "history": [],
            "learnerId": "b@example.com",
            "plan": _plan(sound="u"),
        },
    )
    assert other.json()["plan"]["sound"] == "u"
    record = (tmp_path / "store" / "learner_progress" / "a@example.com.json").read_text(encoding="utf-8")
    assert '"usable":1' in record
    other_record = (tmp_path / "store" / "learner_progress" / "b@example.com.json").read_text(encoding="utf-8")
    assert '"usable":1' in other_record
    assert "attempt-a" not in other_record


def test_two_usable_tries_move_the_lesson_and_an_illegal_model_choice_does_not(tmp_path):
    class _Messages:
        def __init__(self, choice):
            self.choice = choice

        def parse(self, **_kwargs):
            return type(
                "Parsed",
                (),
                {"parsed_output": VowelPhrasing(observation="Usable voice for ee lasted 2.4 seconds.", plan_choice=self.choice)},
            )()

    class _Client:
        def __init__(self, choice):
            self.messages = _Messages(choice)

    app = create_app(make_settings(tmp_path, anthropic_api_key="sk-test"))
    app.state.vowel_client = _Client("advance")
    client = TestClient(app)
    held = _attempt(usableVoicedSec=2.4)
    response = client.post(
        "/v1/coach",
        json={"attempt": held, "history": [], "learnerId": "a@example.com", "plan": _plan()},
    )
    body = response.json()
    assert body["source"] == "agent"
    assert body["plan"]["sound"] == "i"
    assert body["plan"]["assistance"] == "target-only"
    assert body["nextAction"] == "reduce-assistance"

    app.state.vowel_client = _Client("reduce")
    second = client.post(
        "/v1/coach",
        json={
            "attempt": _attempt(attemptId="attempt-2", usableVoicedSec=2.4),
            "history": [],
            "learnerId": "a@example.com",
            "plan": body["plan"],
        },
    )
    assert second.json()["plan"]["assistance"] == "none"


def test_speech_without_cartesia_is_unavailable(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    response = client.post("/v1/speech", json={"text": "ee, as in see."})
    assert response.status_code == 503
