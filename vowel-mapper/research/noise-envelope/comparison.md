Pooled over all 139 speakers, token by token against Hillenbrand hand values (`research/target-scaling/compare_noise.py`). "old" = default estimator.

### Harmonic envelope for every voice (not shipped)

| Noise dB | Method | Tokens measured | Median abs F1 / F2 error % | ee (iy) F1 bias % | ee F2 bias % | ah F1 bias % |
|---|---|---|---|---|---|---|
| clean | old | 1526 (92%) | 3.0 / 2.7 | +2.3 | -0.9 | -1.4 |
| clean | new | 1578 (95%) | 3.9 / 2.7 | -0.7 | -0.8 | -3.0 |
| 20 | old | 1528 (92%) | 3.0 / 2.8 | +2.5 | -0.7 | -1.5 |
| 20 | new | 1579 (95%) | 3.9 / 2.9 | -0.4 | -0.9 | -2.7 |
| 15 | old | 1532 (92%) | 3.2 / 3.1 | +3.5 | -0.4 | -1.5 |
| 15 | new | 1559 (94%) | 4.0 / 2.9 | -0.7 | -0.6 | -2.7 |
| 10 | old | 1516 (91%) | 3.6 / 3.5 | +4.8 | -0.1 | -2.2 |
| 10 | new | 1509 (91%) | 4.4 / 3.1 | -0.6 | -0.6 | -2.7 |
| 5 | old | 1268 (76%) | 4.2 / 4.3 | +7.1 | -0.4 | -3.7 |
| 5 | new | 1248 (75%) | 4.7 / 3.5 | +0.7 | -0.1 | -3.0 |

### Harmonic envelope only below 170 Hz pitch (shipped as opt-in `harmonicEnvelope`, off by default)

| Noise dB | Method | Tokens measured | Median abs F1 / F2 error % | ee (iy) F1 bias % | ee F2 bias % | ah F1 bias % |
|---|---|---|---|---|---|---|
| clean | old | 1526 (92%) | 3.0 / 2.7 | +2.3 | -0.9 | -1.4 |
| clean | new | 1538 (93%) | 3.0 / 2.6 | +2.8 | -0.8 | -2.0 |
| 20 | old | 1528 (92%) | 3.0 / 2.8 | +2.5 | -0.7 | -1.5 |
| 20 | new | 1536 (93%) | 3.1 / 2.7 | +2.9 | -0.5 | -2.0 |
| 15 | old | 1532 (92%) | 3.2 / 3.1 | +3.5 | -0.4 | -1.5 |
| 15 | new | 1543 (93%) | 3.2 / 2.9 | +3.5 | -0.3 | -2.0 |
| 10 | old | 1516 (91%) | 3.6 / 3.5 | +4.8 | -0.1 | -2.2 |
| 10 | new | 1531 (92%) | 3.4 / 3.3 | +4.1 | -0.0 | -2.1 |
| 5 | old | 1268 (76%) | 4.2 / 4.3 | +7.1 | -0.4 | -3.7 |
| 5 | new | 1294 (78%) | 4.2 / 4.1 | +5.4 | -0.3 | -3.4 |
