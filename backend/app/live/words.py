"""Server-side copy of the practice words: zone labels, phonemes and body hints.

Mirrors web/src/game/words.ts (track, sheep, rent, brain) exactly for the fields the coach needs. Keep the two in sync.
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
        ZoneInfo("r", "r", "r", "liquid", "Curl the tongue tip back, or bunch it up, and keep the voice going.",
                 "Curl the tongue tip back, or bunch it up, and keep the voice going.", "after the t"),
        ZoneInfo("a", "ae", "a", "vowel", "Jaw open, tongue low and forward.",
                 "Open wide, tongue low and forward.", "in the middle"),
        ZoneInfo("k", "k", "ck", "stop", "Back of the tongue up, then release.",
                 "Back of the tongue up, then release.", "at the end"),
    ),
)

SHEEP = WordInfo(
    word="sheep",
    zones=(
        ZoneInfo("sh", "sh", "sh", "fricative", "Pull the tongue back a little, then push a long, soft stream of air.",
                 "Pull the tongue back a little, then push a long, soft stream of air.", "at the start"),
        ZoneInfo("ee", "iy", "ee", "vowel", "Lips spread wide, tongue high and forward.",
                 "Tongue high and forward, held steady.", "in the middle"),
        ZoneInfo("p", "p", "p", "stop", "Close the lips, build a little air, then let it pop.",
                 "Seal the front of the mouth, build a little air, then let it pop.", "at the end"),
    ),
)

RENT = WordInfo(
    word="rent",
    zones=(
        ZoneInfo("r", "r", "r", "liquid", "Curl the tongue tip back, or bunch it up, and keep the voice going.",
                 "Curl the tongue tip back, or bunch it up, and keep the voice going.", "at the start"),
        ZoneInfo("e", "eh", "e", "vowel", "Jaw half open, tongue in the middle and a little forward.",
                 "Tongue in the middle and a little forward.", "in the middle"),
        ZoneInfo("n", "n", "n", "nasal", "Tongue tip up behind the teeth and let the voice hum through the nose.",
                 "Tongue tip up behind the teeth and let the voice hum through the nose.", "after the e"),
        ZoneInfo("t", "t", "t", "stop", "Tongue tip up behind the teeth, then let go.",
                 "Tongue tip up behind the teeth, then let go.", "at the end"),
    ),
)

BRAIN = WordInfo(
    word="brain",
    zones=(
        ZoneInfo("b", "b", "b", "stop", "Close the lips, then pop them open with your voice on.",
                 "Seal the front of the mouth, then pop it open with your voice on.", "at the start"),
        ZoneInfo("r", "r", "r", "liquid", "Curl the tongue tip back, or bunch it up, and keep the voice going.",
                 "Curl the tongue tip back, or bunch it up, and keep the voice going.", "after the b"),
        ZoneInfo("ai", "ey", "ai", "vowel", "Start with the jaw half open, then glide up toward a smile.",
                 "Start with the tongue in the middle, then glide up and forward.", "in the middle"),
        ZoneInfo("n", "n", "n", "nasal", "Tongue tip up behind the teeth and let the voice hum through the nose.",
                 "Tongue tip up behind the teeth and let the voice hum through the nose.", "at the end"),
    ),
)

WORDS: dict[str, WordInfo] = {w.word: w for w in (TRACK, SHEEP, RENT, BRAIN)}

# Zone -> mouth-demo cue. The demo has only lip/jaw cues (round-lips, spread-lips, open-jaw), so only vowels with
# such a cue map to one; every consonant (and the vowels without a cue) uses the side view with no cue.
ZONE_CUE: dict[str, str] = {"a": "open-jaw", "ee": "spread-lips"}


def word_info(word: str) -> WordInfo | None:
    return WORDS.get(word.strip().lower())
