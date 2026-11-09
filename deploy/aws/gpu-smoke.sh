#!/usr/bin/env bash
# Smoke test for the GPU container. Run ON the EC2 instance (or any Docker host) after `docker run`:
#   deploy/aws/gpu-smoke.sh [container-name] [clip.wav]
# Defaults: container "articulate-gpu"; a synthetic 1.5 s vowel-like clip (inference path only; the phones
# it decodes are not meaningful). Pass a real speech WAV as the 2nd argument for a meaningful transcript.
# Checks: both /health endpoints from the HOST (published ports), engine/device, /v1/phones/score with
# targets t r-turned ae k (prints inferMs), and the /ws/phones stream via services/phones/scripts/ws_smoke.py
# run inside the container. Env: EXPECT_ENGINE / EXPECT_DEVICE (defaults torch-fp16 / cuda) are only
# warned about, not failed, so the same script works for a CPU test run. Exit non-zero on any failure.
set -uo pipefail

C="${1:-articulate-gpu}"
WAV_IN="${2:-}"
PHONES_PORT="${PHONES_PORT:-8020}"
ARTICULATION_PORT="${ARTICULATION_PORT:-8010}"
EXPECT_ENGINE="${EXPECT_ENGINE:-torch-fp16}"
EXPECT_DEVICE="${EXPECT_DEVICE:-cuda}"
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ok() { echo "ok:   $*"; }

docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null | grep -q true || { echo "FAIL: container $C is not running" >&2; exit 1; }

# 1. health endpoints as seen from the host (proves the published ports work)
ph=$(curl -fsS --max-time 10 "http://127.0.0.1:${PHONES_PORT}/health") || { bad "phones /health unreachable on :${PHONES_PORT}"; ph=""; }
[ -n "$ph" ] && echo "phones health: $ph"
art=$(curl -fsS --max-time 10 "http://127.0.0.1:${ARTICULATION_PORT}/v1/articulation/models") || { bad "articulation unreachable on :${ARTICULATION_PORT}"; art=""; }
[ -n "$art" ] && { ok "articulation answers on :${ARTICULATION_PORT}"; echo "articulation: ${art:0:300}"; }

if [ -n "$ph" ]; then
  echo "$ph" | grep -q '"ok":true' && ok "phones model loaded" || bad "phones /health ok is not true (model not loaded)"
  engine=$(echo "$ph" | sed -n 's/.*"engine":"\([^"]*\)".*/\1/p')
  device=$(echo "$ph" | sed -n 's/.*"device":"\([^"]*\)".*/\1/p')
  echo "engine=${engine:-?} device=${device:-?}"
  [ "$engine" = "$EXPECT_ENGINE" ] || echo "warn: engine ${engine:-?} != expected ${EXPECT_ENGINE}" >&2
  [ "$device" = "$EXPECT_DEVICE" ] || echo "warn: device ${device:-?} != expected ${EXPECT_DEVICE}" >&2
fi

# 2. test clip, inside the container
if [ -n "$WAV_IN" ]; then
  docker cp "$WAV_IN" "$C:/tmp/smoke.wav" || bad "could not copy $WAV_IN"
else
  docker exec "$C" python -c "
import numpy as np, soundfile as sf
sr = 16000; t = np.arange(int(sr * 1.5)) / sr
f0 = 120 + 20 * np.sin(2 * np.pi * 2 * t)
ph = 2 * np.pi * np.cumsum(f0) / sr
x = sum(np.sin(k * ph) / k for k in range(1, 20)) * np.hanning(t.size) * 0.3
sf.write('/tmp/smoke.wav', x.astype('float32'), sr)" || bad "could not synthesize clip"
fi

# 3. POST /v1/phones/score
docker exec -e PORT="$PHONES_PORT" "$C" python -c "
import base64, json, os, sys, urllib.request
audio = base64.b64encode(open('/tmp/smoke.wav', 'rb').read()).decode()
body = json.dumps({'audioBase64': audio, 'targets': ['t', '\u0279', '\u00e6', 'k']}).encode()
req = urllib.request.Request('http://127.0.0.1:%s/v1/phones/score' % os.environ['PORT'], body, {'Content-Type': 'application/json'})
try:
    r = json.load(urllib.request.urlopen(req, timeout=120))
except Exception as e:
    print('score request failed:', e); sys.exit(1)
print('score: engine=%s inferMs=%s alignLogProb=%s' % (r['engine'], r['inferMs'], r['alignLogProb']))
print('targets:', ' '.join('%s(post=%.2f)' % (t['p'], t['post']) for t in r['targets']))
print('decoded:', ' '.join(p['p'] for p in r['phones']) or '-')
" && ok "/v1/phones/score" || bad "/v1/phones/score failed"

# 4. WebSocket stream (real-time paced is slow; --fast sends everything at once)
if docker exec "$C" python /app/services/phones/scripts/ws_smoke.py /tmp/smoke.wav --fast \
     --url "ws://127.0.0.1:${PHONES_PORT}/ws/phones" 2>&1 | tail -n 12 | tee /dev/stderr | grep -q "ready:"; then
  ok "/ws/phones streamed"
else
  bad "/ws/phones smoke failed (no ready message)"
fi

[ "$fail" = 0 ] && echo "SMOKE PASSED" || echo "SMOKE FAILED" >&2
exit "$fail"
