import numpy as np

from phones.align import forced_align, log_softmax, resolve_symbol, score_targets, spans_to_boundaries, variant_ids

TOK = ["<pad>", "t", "ɹ", "æ", "k", "kʰ", "n"]
TOK2ID = {t: i for i, t in enumerate(TOK)}
ID2TOK = dict(enumerate(TOK))


def synth(seq, frames_per=2, gap=2, lead=3, tail=3, peak=8.0):
    """Spiky logits: blank everywhere, each phone `frames_per` frames, `gap` blanks between."""
    def frame(tok):
        r = np.zeros(len(TOK))
        r[tok] = peak
        return r

    rows = [frame(0)] * lead
    for s in seq:
        rows += [frame(TOK2ID[s])] * frames_per + [frame(0)] * gap
    rows += [frame(0)] * tail
    return log_softmax(np.array(rows))


def test_order_and_spans():
    lp = synth(["t", "ɹ", "æ", "k"])
    spans, total = forced_align(lp, [1, 2, 3, 4], 0)
    assert spans[0] == (3, 4) and spans[1] == (7, 8) and spans[3] == (15, 16)
    assert np.isfinite(total) and total < 0


def test_boundaries_split_blanks():
    b = spans_to_boundaries([(3, 4), (7, 8)], 20.0, n_frames=20)
    assert b[0]["startMs"] == 20 and b[1]["startMs"] == b[0]["endMs"] == 120
    assert b[0]["peakMs"] == 80.0 and b[1]["endMs"] == 180 + 40


def test_missing_phone_scores_low():
    lp = synth(["t", "æ", "k"])  # no ɹ
    scores, _, _ = score_targets(lp, ["t", "ɹ", "æ", "k"], TOK2ID, ID2TOK, 0)
    assert scores[1].post < 0.1
    assert min(scores[0].post, scores[2].post, scores[3].post) > 0.5
    assert scores[1].gop < 0 < scores[0].gop


def test_aspiration_fold_and_alias():
    lp = synth(["t", "ɹ", "æ", "kʰ"])
    tg = ["t", resolve_symbol("r", TOK2ID), "æ", "k"]
    scores, _, _ = score_targets(lp, tg, TOK2ID, ID2TOK, 0)
    assert scores[3].post > 0.9 and scores[1].post > 0.9
    assert variant_ids("k", TOK2ID) == [4, 5] and resolve_symbol("zz", TOK2ID) is None


def test_best_competitor():
    lp = synth(["t", "n", "æ", "k"])
    scores, _, _ = score_targets(lp, ["t", "ɹ", "æ", "k"], TOK2ID, ID2TOK, 0)
    assert scores[1].best == "n"
