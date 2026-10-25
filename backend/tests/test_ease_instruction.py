from app.live.decision import ease_repeated_instruction
from app.live.schemas import CoachDecision


def _decision(**extra) -> CoachDecision:
    base = {
        "observation": "The ee sat away from the target area.",
        "caption": "Spread your lips a little wider, then try again.",
        "cueId": "spread-lips",
        "nextAction": "retry",
        "evidenceFields": ["audio.verdict"],
    }
    base.update(extra)
    return CoachDecision(**base)


def _try(verdict: str = "off", cue: str = "spread-lips", action: str = "retry") -> dict:
    return {"sound": "i", "cueId": cue, "nextAction": action, "audioVerdict": verdict}


def test_same_cue_twice_steps_down_to_a_shorter_try():
    eased = ease_repeated_instruction(_decision(), sound="i", recent=[_try(), _try("close")])
    assert eased is not None
    assert "easier" in eased.caption.lower()
    assert "short ee" in eased.caption
    assert eased.cueId == "spread-lips"
    assert eased.nextAction == "retry"


def test_one_repeat_keeps_the_instruction():
    assert ease_repeated_instruction(_decision(), sound="i", recent=[_try()]) is None


def test_a_different_cue_or_a_landed_try_does_not_count():
    recent = [_try(cue="round-lips"), _try("on_target"), _try("insufficient")]
    assert ease_repeated_instruction(_decision(), sound="i", recent=recent) is None


def test_rest_is_left_alone():
    assert ease_repeated_instruction(_decision(nextAction="rest"), sound="i", recent=[_try(), _try()]) is None
