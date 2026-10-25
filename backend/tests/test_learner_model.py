"""Learner model: per-sound outcomes from the compact timeline. Pure, no I/O."""

from typing import Any

from app.live.learner_model import STRUGGLE_STREAK, build_learner_model, prompt_view
from app.live.schemas import WordAttempt


def wturn(zones: dict[str, str], word="track", quality="usable", focus=None, caption=None, cue=None, advisory=()):
    kinds = {"t": "stop", "r": "liquid", "a": "vowel", "k": "stop"}
    return {
        "kind": "word", "attemptId": f"w-{id(zones)}-{caption}", "word": word, "verdict": None, "quality": quality,
        "zones": [
            {"id": z, "phoneme": z, "kind": kinds.get(z, "stop"), "verdict": v, "advisory": z in advisory}
            for z, v in zones.items()
        ],
        "focusZoneId": focus, "cueId": cue, "nextAction": "retry", "caption": caption,
    }


def vturn(sound="u", verdict="off", cue=None, action="retry"):
    return {"attemptId": "v", "sound": sound, "audioVerdict": verdict, "cueId": cue, "nextAction": action}


def test_streak_counts_leading_misses():
    tl = [wturn({"k": "miss"}), wturn({"k": "miss"}), wturn({"k": "hit"}), wturn({"k": "miss"})]
    m = build_learner_model(tl)["k"]
    assert (m["missStreak"], m["misses"], m["usable"], m["attempts"]) == (2, 3, 4, 4)
    assert m["persistent"] is (2 >= STRUGGLE_STREAK)
    assert m["recent"] == ["miss", "miss", "hit", "miss"]


def test_hit_in_front_breaks_streak():
    m = build_learner_model([wturn({"k": "hit"}), wturn({"k": "miss"}), wturn({"k": "miss"})])["k"]
    assert m["missStreak"] == 0 and not m["persistent"]


def test_unclear_turns_are_skipped_not_counted():
    tl = [wturn({"k": "miss"}), wturn({"k": "miss"}, quality="unclear"), wturn({"k": "miss"})]
    m = build_learner_model(tl)["k"]
    assert (m["missStreak"], m["misses"], m["unclear"], m["usable"]) == (2, 2, 1, 2)
    only_unclear = build_learner_model([wturn({"k": "miss"}, quality="unclear")] * 3)["k"]
    assert only_unclear["misses"] == 0 and not only_unclear["persistent"]


def test_advisory_zones_excluded():
    m = build_learner_model([wturn({"r": "miss", "k": "miss"}, advisory=("r",))])
    assert "r" not in m and "k" in m


def test_skipped_counts_as_miss_and_partial_breaks_streak():
    assert build_learner_model([wturn({"k": "skipped"})])["k"]["recent"] == ["miss"]
    m = build_learner_model([wturn({"k": "partial"}), wturn({"k": "miss"})])["k"]
    assert m["missStreak"] == 0 and m["recent"] == ["partial", "miss"]


def test_recent_is_capped():
    m = build_learner_model([wturn({"k": "miss"})] * 8)["k"]
    assert len(m["recent"]) == 5 and m["misses"] == 8


def test_help_after_coaching_and_last_advice():
    tl = [
        wturn({"k": "hit"}, word="back"),
        wturn({"k": "miss"}, focus="k", caption="third line", cue="c2"),
        wturn({"k": "miss"}, focus="k", caption="second line"),
        wturn({"k": "miss"}, focus="k", caption="first line", cue="c1"),
    ]
    m = build_learner_model(tl)["k"]
    assert m["timesCoached"] == 3
    assert m["helpedAfterCoaching"] == 1  # only the coaching before the hit led to improvement
    assert m["lastAdvice"] == "third line"
    assert m["cuesTried"] == ["c2", "c1"]
    assert m["words"] == ["back", "track"]


def test_unclear_coached_turn_does_not_count():
    m = build_learner_model([wturn({"k": "miss"}, quality="unclear", focus="k", caption="x")])["k"]
    assert m["timesCoached"] == 0 and m["lastAdvice"] is None


def test_vowel_units():
    tl = [vturn(verdict="off", cue="round-lips"), vturn(verdict="insufficient"), vturn(verdict="off"),
          vturn(verdict="close"), vturn(sound="i", verdict="on_target")]
    model = build_learner_model(tl)
    u = model["vowel:u"]
    assert (u["attempts"], u["usable"], u["unclear"], u["missStreak"]) == (4, 3, 1, 2)
    assert u["persistent"] and u["timesCoached"] == 1 and u["cuesTried"] == ["round-lips"]
    assert u["lastAdvice"] is None
    assert model["vowel:i"]["recent"] == ["hit"]


def test_vowel_help_after_coaching():
    tl = [vturn(verdict="close"), vturn(verdict="off", cue="round-lips")]
    assert build_learner_model(tl)["vowel:u"]["helpedAfterCoaching"] == 1


def test_prompt_view_other_struggles_order_and_limit():
    tl = []
    for _ in range(2):
        tl.append(wturn({"t": "miss"}))
    for _ in range(4):
        tl.append(wturn({"k": "miss"}, word="back"))
    tl += [vturn(sound="u"), vturn(sound="u"), vturn(sound="u"), vturn(sound="a"), vturn(sound="a")]
    model = build_learner_model(tl)
    view = prompt_view(model, limit=3)
    assert [s["unit"] for s in view["otherStruggles"]] == ["k", "vowel:u", "t"]
    assert view["otherStruggles"][0]["words"] == ["back"]
    assert len(prompt_view(model, limit=1)["otherStruggles"]) == 1
    assert "thisWord" not in view and "thisSound" not in view


def test_prompt_view_word_and_sound():
    model = build_learner_model([wturn({"k": "miss", "a": "hit"}), wturn({"k": "miss", "a": "hit"}), vturn(sound="u"), vturn(sound="u")])
    word = WordAttempt.model_validate({
        "word": "track", "attemptId": "x", "durationMs": 1, "quality": "usable",
        "zones": [
            {"zoneId": "k", "phoneme": "k", "kind": "stop", "verdict": "miss", "dwellMs": 0},
            {"zoneId": "r", "phoneme": "r", "kind": "liquid", "verdict": "hit", "dwellMs": 1},
        ],
    })
    v = prompt_view(model, word=word)
    assert [z["zoneId"] for z in v["thisWord"]] == ["k"] and v["thisWord"][0]["persistent"] is True
    assert "thisSound" not in v and [s["unit"] for s in v["otherStruggles"]] == ["vowel:u"]
    s = prompt_view(model, sound="u")
    assert s["thisSound"]["persistent"] is True and "thisWord" not in s
    assert [x["unit"] for x in s["otherStruggles"]] == ["k"]
    assert prompt_view({}, sound="u")["thisSound"] is None
    assert prompt_view({}, word=word)["thisWord"] == []


def test_out_of_scope_zones_are_skipped_entirely():
    t = wturn({"a": "hit", "k": "skipped"})
    t["zones"][1]["inScope"] = False
    m = build_learner_model([t, t])
    assert "k" not in m and m["a"]["recent"] == ["hit", "hit"]


def test_vowel_turn_caption_is_last_advice():
    tl = [{**vturn(verdict="off", cue="round-lips"), "caption": "Round a little more."}, vturn(verdict="off")]
    assert build_learner_model(tl)["vowel:u"]["lastAdvice"] == "Round a little more."
