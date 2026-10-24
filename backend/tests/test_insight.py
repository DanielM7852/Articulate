"""Insight lane: claim -> template, strict validation, compose_line fallbacks."""

import asyncio

import pytest

from app.live.insight import InsightDraft, claim_allowed, compose_line, template_line, validate_insight
from tests.support import make_settings

DIRECTIONS = ("lower", "higher", "further_back", "further_forward")
DROPPED = {("a", "lower"), ("u", "further_back"), ("i", "further_forward")}


def claim(direction):
    dim = "height" if direction in ("lower", "higher") else "frontness"
    return {"part": "tongue", "dimension": dim, "direction": direction, "comparedTo": ["x"], "sparcDelta": 0.5,
            "formantDelta": 0.1}


class FakeClient:
    def __init__(self, say=None, exc=None):
        self.calls = []
        outer = self

        class Messages:
            def parse(self, **kw):
                outer.calls.append(kw)
                if exc:
                    raise exc
                return type("R", (), {"parsed_output": InsightDraft(say=say), "stop_reason": "end_turn"})()

        self.messages = Messages()


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("sound", ["i", "u", "a"])
@pytest.mark.parametrize("direction", DIRECTIONS)
def test_templates_pass_for_allowed_pairs_and_dropped_otherwise(sound, direction):
    c = claim(direction)
    if (sound, direction) in DROPPED:
        assert not claim_allowed(sound, c)
        with pytest.raises(ValueError):
            validate_insight(template_line(sound, c), sound, c)
    else:
        line = template_line(sound, c)
        validate_insight(line, sound, c)
        assert "tongue" in line and "recent" in line and "last try" not in line


def bad(say, sound="i", direction="lower"):
    with pytest.raises(ValueError):
        validate_insight(say, sound, claim(direction))


def test_rejections():
    ok = "Compared with your best ee tries, your tongue sat a little below. Try lifting it a little higher."
    validate_insight(ok, "i", claim("lower"))
    bad("Compared with your best ee tries, your lips sat a little below. Try lifting it a little higher.")  # no tongue
    bad("Your tongue sat a little below. Try lifting it a little higher.")  # no comparison
    bad("Compared with your best ee tries, your tongue sat a little below. Try bringing it forward.")  # wrong direction
    bad("Compared with your best ee tries, your tongue sat a little lower. Try lifting it a little higher.")  # opposite word
    bad("I can see your tongue. Compared with your best ee tries, it sat a little below. Try lifting it higher.")
    bad("Compared with your best 2 ee tries, your tongue sat a little below. Try lifting it a little higher.")
    bad(ok + " " + ok)  # too many sentences / long
    bad("Compared with your best ee tries, your tongue sat a little below. Try lifting it higher. " + "x" * 300)
    bad("Compared with your best ee tries, your tongue sat a little below. That was bad. Try lifting it higher.")
    bad("", "i", "lower")
    # contradicts target facts: ah is low, so lifting it high is wrong (and dropped)
    bad("Compared with your best ah tries, your tongue sat a little below. Try lifting it high.", "a", "lower")
    # oo tongue is back, so bringing it forward contradicts
    bad("Compared with your best oo tries, your tongue sat a little closer to the throat. Try bringing it forward.",
        "u", "further_back")
    # unknown / malformed claims
    with pytest.raises(ValueError):
        validate_insight(ok, "i", {"part": "lips", "direction": "lower"})


def test_compose_agent_line_used_when_valid(tmp_path):
    s = make_settings(tmp_path, anthropic_api_key="k")
    line = "Compared with your best ee tries, your tongue sat a little below. Try lifting it a little higher."
    client = FakeClient(line)
    say, source = run(compose_line(s, client, "i", claim("lower"), [{"sound": "i", "audioVerdict": "off"}]))
    assert (say, source) == (line, "agent")
    call = client.calls[0]
    assert call["model"] == s.live_insight_model == "claude-opus-5-5"
    assert call["output_config"] == {"effort": "high"}
    assert "recentAttempts" in call["messages"][0]["content"]


def test_compose_invalid_or_failing_model_uses_template(tmp_path):
    s = make_settings(tmp_path, anthropic_api_key="k")
    tpl = template_line("i", claim("lower"))
    for client in (
        FakeClient("I can see your tongue is too low. Try again."),
        FakeClient("Compared with your best ee tries, your tongue sat a little below. Try bringing it forward."),
        FakeClient(exc=TimeoutError("slow")),
    ):
        assert run(compose_line(s, client, "i", claim("lower"), [])) == (tpl, "fallback")


def test_compose_without_model_does_not_call(tmp_path):
    s = make_settings(tmp_path)
    assert run(compose_line(s, None, "i", claim("lower"), [])) == (template_line("i", claim("lower")), "fallback")


def test_compose_dropped_claim_raises(tmp_path):
    with pytest.raises(ValueError):
        run(compose_line(make_settings(tmp_path), None, "a", claim("lower"), []))
