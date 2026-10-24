# Before / after verification

The final full five-condition run was repeated after implementing the offline harness and default-off UI preview. Production estimator and tracker code stayed unchanged. The 47,610 labelled per-frame records match the patched baseline byte-for-byte (compressed JSON SHA-256 `4eae37f3f1526518af0ab7ee669680c9372590e822e12eef7507565d91512604`).

| Check | Baseline | Final |
|---|---:|---:|
| Clips | 335 | 335 |
| Conditions | clean, 20, 15, 10, 5 dB | clean, 20, 15, 10, 5 dB |
| Analysed frames | 112,300 | 112,300 |
| Eligible full-window frames | 47,610 | 47,610 |
| Per-frame output | identical | identical |

All acceptance/error numbers in [baseline.md](baseline.md) therefore apply before and after. This demonstrates unchanged acoustic behavior, not an improvement. The work adds measured evidence, reproducibility and a scripted representation study.

Estimator SHA-256: `cd8feb87a323b741a3e283ed5af96c647b24f597752b608d7e9b1a030df3cc94`.

Manifest SHA-256: `32626e3a228e67a1c54ca9bf72613777837967297274114dbbe9a6fae7dfb378`.
