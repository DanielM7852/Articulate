import json

import pytest

from app.live import notes
from app.live.decision import DecisionError
from app.live.schemas import NotesDraft, Struggle

CLAIM = {"part": "tongue", "dimension": "height", "direction": "lower", "comparedTo": ["a0"],
         "sparcDelta": 0.7312, "formantDelta": 123.4}


def attempts(with_claim: bool):
    a = {"attemptId": "a1", "sound": "i", "audioVerdict": "off"}
    if with_claim:
        a["articulation"] = {"quality": "ok", "claims": [CLAIM]}
    return [a]


def draft(text: str) -> NotesDraft:
    return NotesDraft(summary=text, struggles=[Struggle(sound="i", pattern="x", count=1, lastAttemptId="a1")], habits=[])


COMPARATIVE = "On some ee tries the tongue sat lower than on their best ee tries."


def test_no_claims_rejects_tongue():
    with pytest.raises(DecisionError):
        notes._validate(draft(COMPARATIVE), attempts(False))


def test_claims_allow_comparative():
    assert notes._validate(draft(COMPARATIVE), attempts(True)).summary == COMPARATIVE


def test_claims_reject_non_comparative():
    with pytest.raises(DecisionError):
        notes._validate(draft("The tongue sat low."), attempts(True))


def test_claims_reject_observation():
    with pytest.raises(DecisionError):
        notes._validate(draft("I noticed the tongue sat lower than on their best tries."), attempts(True))


def test_claims_still_reject_digits():
    with pytest.raises(DecisionError):
        notes._validate(draft("Tongue sat lower than on best tries 2 times."), attempts(True))


def test_model_payload_has_no_deltas():
    sent = json.dumps(notes._model_attempts(attempts(True)))
    assert "sparcDelta" not in sent and "formantDelta" not in sent and "0.7312" not in sent
    assert '"direction":' in sent.replace(" ", "")


def test_model_payload_has_no_deltas():
    sent = json.dumps(notes._model_attempts(attempts(True)))
    assert "sparcDelta" not in sent and "formantDelta" not in sent and "0.7312" not in sent
    assert "direction" in sent
