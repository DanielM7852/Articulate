"""Server-side copy of the practice words: zone labels, phonemes and body hints.

Mirrors web/src/game/words.ts (TRACK) exactly for the fields the coach needs. Keep the two in sync.
Targets (Hz) stay on the client; the server only needs what Ava may say about each zone.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ZoneInfo:
    id: str
    phoneme: str
    label: str
    kind: str
    hint: str
    # Hint used when the camera is not usable: no lip/jaw words (the coach only names lips or jaw with usable video).
    hint_no_camera: str
    # Where the zone sits in the word, for the fallback line ("at the start", "at the end").
    position: str


@dataclass(frozen=True)
class WordInfo:
    word: str
    zones: tuple[ZoneInfo, ...]

    def zone(self, zone_id: str) -> ZoneInfo | None:
        return next((z for z in self.zones if z.id == zone_id), None)


TRACK = WordInfo(
    word="track",
    zones=(
        ZoneInfo("t", "t", "t", "stop", "Tongue tip up behind the teeth, then let go.",
                 "Tongue tip up behind the teeth, then let go.", "at the start"),
        ZoneInfo("r", "r", "r", "tuner", "Curl the tongue tip back, or bunch it up. Pull the needle down.",
                 "Curl the tongue tip back, or bunch it up. Pull the needle down.", "after the t"),
        ZoneInfo("a", "ae", "a", "vowel", "Jaw open, tongue low and forward.",
                 "Open wide, tongue low and forward.", "in the middle"),
        ZoneInfo("k", "k", "ck", "stop", "Back of the tongue up, then release.",
                 "Back of the tongue up, then release.", "at the end"),
    ),
)

WORDS: dict[str, WordInfo] = {"track": TRACK}

# Zone -> mouth-demo cue. The demo has only lip/jaw cues (round-lips, spread-lips, open-jaw), so only the
# vowel maps to one; tongue zones (t, r, ck) use the side view with no cue.
ZONE_CUE: dict[str, str] = {"a": "open-jaw"}


def word_info(word: str) -> WordInfo | None:
    return WORDS.get(word.strip().lower())
