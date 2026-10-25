"""Ava is one voice: no mention of a separate coach/model, tools renamed, safety rules intact."""
import re

from app.realtime.persona import CLIENT_TOOLS, TOOLS, instructions

BANNED = re.compile(r"\b(coach\w*|claude|gpt|relay\w*|supervisor)\b", re.IGNORECASE)


def _tool_texts():
    for tool in TOOLS:
        yield tool["name"] + " description", tool["description"]
        for pname, prop in tool["parameters"].get("properties", {}).items():
            yield f'{tool["name"]}.{pname}', prop.get("description", "")


def test_instructions_have_no_banned_words():
    assert not BANNED.search(instructions("Ava"))


def test_tool_descriptions_have_no_banned_words():
    for label, text in _tool_texts():
        assert not BANNED.search(text), label


def test_tool_names():
    assert {t["name"] for t in TOOLS} == {
        "review_attempt", "start_practice", "end_practice", "learner_attempt", "stay_quiet", "think_it_through", "show_demo", "lesson_control",
    }
    assert CLIENT_TOOLS == {
        "start_practice", "end_practice", "learner_attempt", "stay_quiet", "show_demo", "lesson_control",
    }
    by_name = {t["name"]: t["parameters"] for t in TOOLS}
    assert by_name["think_it_through"]["required"] == ["question"]
    assert by_name["review_attempt"]["required"] == ["attempt_id"]


def test_one_voice_rules_present():
    text = instructions("Ava")
    for phrase in (
        "Never mention to the learner",
        "your own notes",
        "in your own words",
        "keep fillers to a few words, vary them and do not reuse one you said recently",
        "A filler never hints at the answer",
        "Do not repeat the same sentence twice in a session, except words an [app] message tells you to say exactly",
        "Vary your phrasing",
        "You never judge speech from your own impression",
        "[app]",
        "untrusted",
    ):
        assert phrase in text, phrase


def test_safety_rules_still_present():
    text = instructions("Ava")
    for phrase in (
        "Never write digits or numbers of any kind",
        'Never say "listen", "hear", "sounds like" or "sounded"',
        "Never use the words wrong, bad, fail or incorrect",
        "Never describe what the learner's tongue, lips or jaw did",
        "Never infer emotions",
        "Restrained praise only",
        "Respect the learner's choices",
        "about thirty words at most",
        "Tie-break: three words or fewer",
        "stay_quiet",
        "If the capture was unclear, take ownership",
        "Only say a try landed or did not land when your notes say so",
    ):
        assert phrase in text, phrase


def test_demo_and_lesson_tool_schemas():
    by_name = {t["name"]: t["parameters"] for t in TOOLS}
    demo = by_name["show_demo"]
    assert demo["required"] == ["what", "speed"] and demo["additionalProperties"] is False
    assert demo["properties"]["what"]["enum"] == ["mouth_cue", "side_view", "ghost_path"]
    assert demo["properties"]["speed"]["enum"] == ["slow", "normal"]
    ctl = by_name["lesson_control"]
    assert ctl["required"] == ["action"] and ctl["additionalProperties"] is False
    assert ctl["properties"]["action"]["enum"] == ["next_part", "repeat_part", "try_now", "next_word", "finish"]
    assert {"show_demo", "lesson_control"} <= CLIENT_TOOLS


def test_instructions_cover_demos_and_screen():
    text = instructions("Ava")
    for phrase in ('"On screen:"', "show_demo", "lesson_control", "mouth_cue", "speed slow", "repeat_part",
                   "Never invent what is on screen", "without think_it_through"):
        assert phrase in text, phrase
