"""Content-verification hook.

No speech recognizer is configured. Until one is supplied, every comparison
returns content_verified=false and limits what the coaching text may claim.
"""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ContentCheck:
    verified: bool
    reason: str
    verifier: str


class ContentVerifier:
    name = "not_configured"

    def verify(self, *, expected_transcript: str, samples: np.ndarray, sample_rate: int) -> ContentCheck:
        del expected_transcript, samples, sample_rate
        return ContentCheck(False, "content_verifier_not_configured", self.name)


class RejectingContentVerifier(ContentVerifier):
    """Fixture-only verifier. It does not inspect audio."""

    name = "fixture_reject"

    def verify(self, *, expected_transcript: str, samples: np.ndarray, sample_rate: int) -> ContentCheck:
        del expected_transcript, samples, sample_rate
        return ContentCheck(False, "content_mismatch", self.name)
