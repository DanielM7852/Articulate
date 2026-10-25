"""CTC forced alignment + per-target scoring (numpy only).

Aspiration folding: a target symbol X is scored as the union of X and its aspirated variant Xʰ (when in vocab);
target 'r' is accepted as 'ɹ'. Alignment runs on one merged column per target symbol
(logsumexp of the variant log-probs) plus the blank column.

Boundaries: CTC posteriors are spiky, so each phone's *emitted* frames (frames the Viterbi path spends in that
token state) give its peak (centre of the emitted frames). Boundaries between neighbours are the midpoint between
the end of one's emitted frames and the start of the next's, so blank frames are split evenly. The first phone's
start and the last phone's end are the emitted-frame edges padded by pad_ms (default 40 ms), clamped to the clip.
No waveform energy is used here; callers wanting energy onsets (e.g. build_word_timing.py) do that themselves.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

NEG = -1e30
ALIASES = {"r": "ɹ"}
ASPIRATION = "ʰ"
SKIP_SYMBOLS = ("<pad>", "<s>", "</s>", "<unk>", "|", " ", "")


def log_softmax(logits: np.ndarray) -> np.ndarray:
    z = logits.astype(np.float64)
    z = z - z.max(axis=-1, keepdims=True)
    return z - np.log(np.exp(z).sum(axis=-1, keepdims=True))


def _lse(a: np.ndarray, axis: int = -1) -> np.ndarray:
    m = a.max(axis=axis, keepdims=True)
    return (m + np.log(np.exp(a - m).sum(axis=axis, keepdims=True))).squeeze(axis)


def viterbi(blank_lp: np.ndarray, tok_lp: np.ndarray, repeats: list[bool] | None = None):
    """CTC Viterbi. blank_lp [T], tok_lp [T, N] (log-prob of each target in order).
    repeats[i] True when target i equals target i-1 (then a blank is required between them).
    Returns (path: target index per frame, -1 for blank; total logprob)."""
    T, N = tok_lp.shape
    if N == 0:
        return np.full(T, -1), float(blank_lp.sum())
    S = 2 * N + 1
    if T < N:
        raise ValueError(f"audio too short: {T} frames for {N} targets")
    repeats = repeats or [False] * N
    emit = np.full((T, S), NEG)
    emit[:, 0::2] = blank_lp[:, None]
    emit[:, 1::2] = tok_lp
    dp = np.full((T, S), NEG)
    bp = np.zeros((T, S), dtype=np.int8)  # 0 stay, 1 from s-1, 2 from s-2
    dp[0, 0] = emit[0, 0]
    dp[0, 1] = emit[0, 1]
    skip_ok = np.zeros(S, dtype=bool)
    for i in range(1, N):
        skip_ok[2 * i + 1] = not repeats[i]
    for t in range(1, T):
        prev = dp[t - 1]
        c1 = np.concatenate(([NEG], prev[:-1]))
        c2 = np.where(skip_ok, np.concatenate(([NEG, NEG], prev[:-2])), NEG)
        stack = np.stack([prev, c1, c2])
        arg = stack.argmax(axis=0)
        dp[t] = stack[arg, np.arange(S)] + emit[t]
        bp[t] = arg
    end = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    total = float(dp[T - 1, end])
    s = end
    states = np.zeros(T, dtype=int)
    for t in range(T - 1, -1, -1):
        states[t] = s
        s -= int(bp[t, s])
    path = np.where(states % 2 == 1, (states - 1) // 2, -1)
    return path, total


def spans_from_path(path: np.ndarray, n: int) -> list[tuple[int, int]]:
    """Per target: (first, last) frame (inclusive) where that token is emitted."""
    spans = []
    for i in range(n):
        idx = np.nonzero(path == i)[0]
        spans.append((int(idx[0]), int(idx[-1])) if idx.size else (-1, -1))
    return spans


def forced_align(logprobs: np.ndarray, target_ids: list[int], blank: int):
    """Plain CTC forced alignment on vocab columns. Returns (spans [(first,last)], total logprob)."""
    ids = list(target_ids)
    repeats = [i > 0 and ids[i] == ids[i - 1] for i in range(len(ids))]
    path, total = viterbi(logprobs[:, blank], logprobs[:, ids], repeats)
    return spans_from_path(path, len(ids)), total


def resolve_symbol(sym: str, tok2id: dict[str, int]) -> str | None:
    """Fold aliases (r -> ɹ); returns the vocab symbol or None when unknown."""
    sym = ALIASES.get(sym, sym)
    return sym if sym in tok2id else None


def variant_ids(sym: str, tok2id: dict[str, int]) -> list[int]:
    """Vocab ids that count as the same phone as sym: X and Xʰ."""
    base = sym[:-1] if sym.endswith(ASPIRATION) else sym
    out = [tok2id[v] for v in (base, base + ASPIRATION) if v in tok2id]
    return out or [tok2id[sym]]


def folded_columns(logprobs: np.ndarray, targets: list[str], tok2id: dict[str, int]) -> np.ndarray:
    """[T, N] log of P(X)+P(Xʰ) per target. Targets must already be resolved vocab symbols."""
    return np.stack([_lse(logprobs[:, variant_ids(s, tok2id)], axis=1) for s in targets], axis=1)


def spans_to_boundaries(spans: list[tuple[int, int]], frame_ms: float, n_frames: int | None = None,
                        pad_ms: float = 40.0) -> list[dict]:
    """Per phone {startMs, endMs, peakMs} from emitted-frame spans (see module docstring)."""
    out = []
    k = len(spans)
    for i, (a, b) in enumerate(spans):
        s, e = a * frame_ms, (b + 1) * frame_ms
        if i == 0:
            start = max(0.0, s - pad_ms)
        else:
            start = ((spans[i - 1][1] + 1) * frame_ms + s) / 2
        if i == k - 1:
            end = e + pad_ms
            if n_frames is not None:
                end = min(end, n_frames * frame_ms)
        else:
            end = (e + spans[i + 1][0] * frame_ms) / 2
        out.append({"startMs": start, "endMs": end, "peakMs": (s + e) / 2})
    return out


@dataclass
class TargetScore:
    p: str
    first: int
    last: int
    post: float
    gop: float
    best: str
    bestPost: float


def score_targets(logprobs: np.ndarray, targets: list[str], tok2id: dict[str, int], id2tok: dict[int, str],
                  blank: int):
    """Align resolved target symbols and score each. Returns (list[TargetScore], spans, total logprob)."""
    cols = folded_columns(logprobs, targets, tok2id)
    repeats = [i > 0 and targets[i] == targets[i - 1] for i in range(len(targets))]
    path, total = viterbi(logprobs[:, blank], cols, repeats)
    spans = spans_from_path(path, len(targets))
    probs = np.exp(logprobs)
    skip = {blank} | {i for i, t in id2tok.items() if t in SKIP_SYMBOLS}
    scores = []
    for i, sym in enumerate(targets):
        a, b = spans[i]
        fr = slice(a, b + 1)
        excl = skip | set(variant_ids(sym, tok2id))
        others = [j for j in range(logprobs.shape[1]) if j not in excl]
        op = probs[fr][:, others]
        best_j = int(op.mean(axis=0).argmax())
        gop = float(np.mean(cols[fr, i] - np.log(np.maximum(op.max(axis=1), 1e-12))))
        scores.append(TargetScore(sym, a, b, float(np.exp(cols[fr, i]).mean()), gop,
                                  id2tok[others[best_j]], float(op[:, best_j].mean())))
    return scores, spans, total
