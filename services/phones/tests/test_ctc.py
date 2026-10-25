import numpy as np

from phones.config import Settings
from phones.ctc import Phone, greedy_decode, split_commit
from phones.stream import StreamSession

ID2TOK = {0: "<pad>", 1: "a", 2: "b", 3: "|"}


def onehot(seq, v=4, hi=8.0):
    x = np.zeros((len(seq), v), dtype=np.float32)
    for i, k in enumerate(seq):
        x[i, k] = hi
    return x


def test_greedy_decode_collapse_blank_and_conf():
    ph = greedy_decode(onehot([0, 1, 1, 0, 1, 2, 2, 2, 3, 0]), ID2TOK, 0, 20.0, offset_ms=100)
    assert [p.p for p in ph] == ["a", "a", "b"]  # blank separates repeated a; '|' skipped
    assert (ph[0].startMs, ph[0].endMs) == (120.0, 160.0)
    assert (ph[2].startMs, ph[2].endMs) == (100 + 5 * 20, 100 + 8 * 20)
    assert 0.9 < ph[0].conf <= 1.0


def test_greedy_decode_empty():
    assert greedy_decode(np.zeros((0, 4), dtype=np.float32), ID2TOK, 0, 20.0) == []


def P(s, e):
    return Phone("a", s, e, 0.9)


def test_split_commit_lag_and_dedupe():
    phones = [P(0, 100), P(100, 300), P(1600, 1900)]
    c, prov, last = split_commit(phones, window_end_ms=2000, commit_lag_ms=500, last_committed_end_ms=-1)
    assert [p.endMs for p in c] == [100, 300]
    assert [p.endMs for p in prov] == [1900]
    assert last == 300
    # next window re-reports the same phones (slightly shifted): no duplicates
    phones2 = [P(2, 101), P(101, 302), P(1600, 1900), P(2000, 2200)]
    c2, prov2, last2 = split_commit(phones2, 2500, 500, last)
    assert [p.endMs for p in c2] == [1900]
    assert [p.endMs for p in prov2] == [2200]
    assert last2 == 1900


def test_commit_is_ordered_prefix():
    c, prov, _ = split_commit([P(0, 1900), P(100, 200)], 2000, 500, -1)
    assert c == [] and len(prov) == 2


def test_stream_session_hop_and_silence():
    s = Settings()
    sess = StreamSession(s)
    calls = []

    def rec(w, start):
        calls.append((len(w), start))
        return [Phone("a", start + 10, start + 50, 0.9)]

    loud = (np.ones(2560, dtype="<i2") * 3000).tobytes()  # 160 ms
    out = []
    for _ in range(10):  # 1.6 s
        sess.push_pcm16(loud)
        m = sess.step(rec)
        if m:
            out.append(m)
    assert 8000 <= calls[0][0] < 8000 + 2560  # first window at >= 500 ms
    assert all(n <= 32000 for n, _ in calls)
    assert [m["seq"] for m in out] == list(range(1, len(out) + 1))
    sess.reset()
    assert sess.total == 0 and sess.seq == 0
    sess.push_pcm16(np.zeros(16000, dtype="<i2").tobytes())
    m = sess.step(rec)
    assert m["inferMs"] == 0.0 and m["committed"] == [] and m["provisional"] == []


def test_same_phone_reshifted_is_deduped():
    last = Phone("a", 100, 200, 0.9)
    c, prov, _ = split_commit([Phone("a", 210, 260, 0.9), Phone("a", 800, 900, 0.9)], 2000, 500, 200, last)
    assert [p.startMs for p in c] == [800]
