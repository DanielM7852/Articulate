# Local mock measurements

Measured on Windows 11 with Python 3.12.13, 30 runs per comparison, no failures. Other local development work may affect these results. Raw values, boundaries and reproduction details are in [latency.json](latency.json) and `python scripts/benchmark.py --runs 30`.

| Boundary / case | Median | p95 |
|---|---:|---:|
| Cold Python API process launch → localhost readiness response | 2259.781 ms | 5080.258 ms |
| New controller/repository, uncached: attempt end → caption event enqueue | 10.241 ms | 11.998 ms |
| Warm controller, uncached: attempt end → caption event enqueue | 4.163 ms | 5.174 ms |
| Warm controller, cached: attempt end → caption event enqueue | 4.532 ms | 8.247 ms |
| Warm uncached: attempt end → first PCM enqueue | 43.331 ms | 44.271 ms |
| Warm cached: attempt end → first PCM enqueue | 4.534 ms | 8.249 ms |

These are **mock provider results**. The acoustic input is synthetic, retrieval and reasoning are deterministic, TTS is a diagnostic tone and persistence is a local outbox. Enqueue timing does not include browser/network delivery, display paint, worklet buffering, device scheduling or hardware sound. Browser diagnostics separately measure visible feedback and first worklet consumption on the browser clock. Real-provider latency remains unmeasured. Faster production than consumption is bounded by a 500 ms transport lead and a two-second browser ring.
