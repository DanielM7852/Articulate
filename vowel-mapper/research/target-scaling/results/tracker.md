# Amendment 2 results: tracker-measured reference

Instrument: production estimator SHA-256 `cd8feb87a323b741…`, manifest `2461447b87bb26af…`. Tokens retained (≥3 accepted frames): 1526 of 1658.

## Pass criteria

| Arm | P1 | P2 | P3 | P4 | Centralisation ratio |
|---|---|---|---|---|---|
| T1 | FAIL | FAIL | FAIL | PASS | 0.034 |
| T1-cal3 | FAIL | FAIL | FAIL | PASS | 0.130 |
| C1-hand-same-tokens | FAIL | FAIL | PASS | PASS | 0.066 |

**Live prototype wording (pre-registered rule on T1-cal3):** shows **graded distance/direction only**.

### T1-cal3: factor from head / had / heard only (deployable)

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A (team) | men | 98 / 100 / 86 (mean 95) | 11 / 91 / 38 (mean 47) | 8.6 |
| A (team) | women | 5 / 29 / 27 (mean 20) | 1 / 88 / 3 (mean 31) | 6.7 |
| A (team) | boys | 0 / 11 / 16 (mean 9) | 0 / 68 / 0 (mean 23) | 5.9 |
| A (team) | girls | 0 / 11 / 15 (mean 9) | 0 / 22 / 0 (mean 7) | 3.6 |
| T1-cal3 | men | 86 / 82 / 93 (mean 87) | 1 / 7 / 99 (mean 36) | 32.2 |
| T1-cal3 | women | 84 / 79 / 51 (mean 71) | 6 / 26 / 99 (mean 43) | 34.1 |
| T1-cal3 | boys | 88 / 71 / 84 (mean 81) | 4 / 0 / 98 (mean 34) | 31.9 |
| T1-cal3 | girls | 88 / 83 / 92 (mean 88) | 8 / 19 / 97 (mean 41) | 32.8 |

Centralisation (30%): median |dS| / radius 0.217 / 0.176 / 0.039; hit on centralised target 8% / 70% / 83%

### T1: factor from all non-target, non-neighbour vowels

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| T1 | men | 86 / 77 / 93 (mean 85) | 0 / 19 / 99 (mean 39) | 32.8 |
| T1 | women | 81 / 75 / 51 (mean 69) | 4 / 22 / 99 (mean 42) | 34.2 |
| T1 | boys | 71 / 68 / 84 (mean 74) | 4 / 2 / 98 (mean 35) | 31.6 |
| T1 | girls | 88 / 89 / 92 (mean 90) | 8 / 22 / 97 (mean 42) | 33.0 |

Centralisation (30%): median |dS| / radius 0.053 / 0.028 / 0.029; hit on centralised target 7% / 56% / 82%

### Hand-measured C1 on the same retained tokens (comparison)

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| C1 hand | men | 81 / 80 / 86 (mean 82) | 5 / 6 / 17 (mean 9) | 1.7 |
| C1 hand | women | 86 / 83 / 83 (mean 84) | 12 / 25 / 51 (mean 29) | 5.6 |
| C1 hand | boys | 67 / 68 / 89 (mean 75) | 13 / 0 / 24 (mean 12) | 2.2 |
| C1 hand | girls | 100 / 56 / 38 (mean 65) | 4 / 6 / 46 (mean 19) | 4.1 |

Centralisation (30%): median |dS| / radius 0.060 / 0.028 / 0.109; hit on centralised target 7% / 57% / 71%

### Coverage: tokens with ≥3 accepted tracker frames

| Group | iy | ih | ei | eh | ae | ah | aw | oa | oo | uw | uh | er |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| men | 96 | 76 | 91 | 93 | 100 | 96 | 98 | 98 | 89 | 96 | 100 | 96 |
| women | 77 | 94 | 92 | 98 | 100 | 98 | 100 | 100 | 100 | 85 | 100 | 96 |
| boys | 89 | 74 | 89 | 93 | 96 | 100 | 96 | 100 | 89 | 77 | 100 | 96 |
| girls | 84 | 68 | 63 | 63 | 63 | 79 | 100 | 100 | 100 | 63 | 89 | 100 |

### Instrument bias: median ln(tracker / hand), F1 / F2 (0.10 ≈ 10%)

| Group | iy | ah | uw | eh | ae | er |
|---|---|---|---|---|---|---|
| men | +0.04 / -0.01 | -0.01 / +0.01 | +0.05 / +0.04 | +0.01 / -0.01 | +0.03 / -0.02 | +0.02 / +0.02 |
| women | +0.02 / -0.00 | -0.02 / +0.01 | +0.10 / +0.16 | +0.00 / +0.01 | +0.05 / -0.03 | +0.04 / -0.04 |
| boys | +0.02 / -0.01 | -0.02 / +0.01 | +0.02 / +0.01 | +0.00 / -0.00 | +0.04 / -0.04 | +0.01 / -0.01 |
| girls | +0.00 / -0.01 | -0.04 / +0.01 | +0.00 / +0.01 | -0.02 / -0.00 | +0.04 / -0.03 | +0.01 / -0.01 |