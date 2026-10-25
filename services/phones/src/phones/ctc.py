"""Pure CTC decode + commit logic (no torch / tensorrt dependency)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SKIP_TOKENS = {"<pad>", "<s>", "</s>", "<unk>", "|", " ", ""}


@dataclass(frozen=True)
class Phone:
    p: str
    startMs: float
    endMs: float
    conf: float

    def as_dict(self) -> dict:
        return {"p": self.p, "startMs": round(self.startMs, 1), "endMs": round(self.endMs, 1), "conf": round(self.conf, 3)}


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits.astype(np.float64) - logits.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return (e / e.sum(axis=-1, keepdims=True)).astype(np.float32)


def greedy_decode(
    logits: np.ndarray,
    id2tok: dict[int, str],
    blank_id: int,
    frame_ms: float,
    offset_ms: float = 0.0,
) -> list[Phone]:
    """Greedy CTC over logits [frames, vocab]. A phone spans its run of identical argmax frames;
    conf is the mean max-softmax over those frames. Times are offset_ms + frame * frame_ms."""
    if logits.ndim != 2 or logits.shape[0] == 0:
        return []
    probs = softmax(logits)
    ids = probs.argmax(axis=-1)
    mx = probs.max(axis=-1)
    out: list[Phone] = []
    i, n = 0, len(ids)
    while i < n:
        j = i
        while j + 1 < n and ids[j + 1] == ids[i]:
            j += 1
        tok = int(ids[i])
        if tok != blank_id:
            sym = id2tok.get(tok, "")
            if sym not in SKIP_TOKENS:
                out.append(Phone(sym, offset_ms + i * frame_ms, offset_ms + (j + 1) * frame_ms, float(mx[i : j + 1].mean())))
        i = j + 1
    return out


def frame_posteriors(
    logits: np.ndarray,
    id2tok: dict[int, str],
    blank_id: int,
    frame_ms: float,
    offset_ms: float = 0.0,
    top_k: int = 5,
    min_p: float = 0.01,
) -> list[dict]:
    """Per-frame {t (frame centre, ms), mass (1 - blank posterior), top [[sym, p], ...]} from logits [frames, vocab].
    top: up to top_k non-blank, non-special symbols by prob desc (not renormalised, 3 decimals, entries < min_p dropped)."""
    if logits.ndim != 2 or logits.shape[0] == 0:
        return []
    probs = softmax(logits)
    skip = {blank_id} | {i for i, t in id2tok.items() if t in SKIP_TOKENS}
    keep = np.array([i for i in range(probs.shape[1]) if i not in skip], dtype=int)
    sub = probs[:, keep]
    k = min(top_k, len(keep))
    out = []
    for f in range(probs.shape[0]):
        row = sub[f]
        idx = np.argsort(-row)[:k]
        top = [[id2tok[int(keep[j])], round(float(row[j]), 3)] for j in idx if row[j] >= min_p]
        mass = min(1.0, max(0.0, 1.0 - float(probs[f, blank_id])))
        out.append({"t": round(offset_ms + (f + 0.5) * frame_ms, 1), "mass": round(mass, 3), "top": top})
    return out


def split_commit(
    phones: list[Phone],
    window_end_ms: float,
    commit_lag_ms: float,
    last_committed_end_ms: float,
    last_phone: Phone | None = None,
) -> tuple[list[Phone], list[Phone], float]:
    """Return (newly committed, provisional, new last_committed_end_ms).

    A phone is committed when it ends at least commit_lag_ms before the window right edge.
    Phones whose midpoint is not after last_committed_end_ms were already committed (dedupe by stream time).
    Commitment is a time-ordered prefix so order is preserved."""
    fresh = [p for p in phones if (p.startMs + p.endMs) / 2 > last_committed_end_ms]
    # A phone re-detected with shifted boundaries right after the same committed phone is the same phone.
    while fresh and last_phone is not None and fresh[0].p == last_phone.p and fresh[0].startMs < last_phone.endMs + 40:
        fresh = fresh[1:]
    cutoff = window_end_ms - commit_lag_ms
    committed: list[Phone] = []
    for p in fresh:
        if p.endMs <= cutoff:
            committed.append(p)
        else:
            break
    provisional = fresh[len(committed):]
    last = max(last_committed_end_ms, committed[-1].endMs) if committed else last_committed_end_ms
    return committed, provisional, last


def rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def normalize(wave: np.ndarray) -> np.ndarray:
    """Wav2Vec2FeatureExtractor(do_normalize=True): zero mean, unit variance per utterance."""
    w = wave.astype(np.float32)
    return ((w - w.mean()) / np.sqrt(w.var() + 1e-7)).astype(np.float32)
