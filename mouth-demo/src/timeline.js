export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createTimeline() {
  let speed = 1;
  let cur = null;

  function finish(run, ok) {
    if (cur === run) cur = null;
    run.resolve(ok);
  }

  function cancel() {
    if (!cur) return;
    const run = cur;
    cur = null;
    run.resolve(false);
  }

  function play(phases, { loop = false, loopStart = 0 } = {}) {
    cancel();
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const list = Array.from(phases || []);
    const run = { list, loop, loopStart, idx: 0, elapsed: 0, started: false, resolve };
    cur = run;
    if (!list.length) finish(run, true);
    return promise;
  }

  function stop() {
    cancel();
  }

  function update(dtMs) {
    const run = cur;
    if (!run) return;
    let rem = Math.max(0, dtMs) * speed;
    while (cur === run) {
      const ph = run.list[run.idx];
      if (!run.started) {
        run.started = true;
        if (ph.onStart) ph.onStart();
        if (cur !== run) return;
      }
      const dur = Math.max(0, ph.duration || 0);
      const need = dur - run.elapsed;
      if (dur > 0 && rem < need) {
        run.elapsed += rem;
        if (ph.onUpdate) ph.onUpdate(run.elapsed / dur);
        return;
      }
      rem -= Math.max(0, need);
      if (ph.onUpdate) ph.onUpdate(1);
      if (cur !== run) return;
      if (ph.onEnd) ph.onEnd();
      if (cur !== run) return;
      run.idx++;
      run.elapsed = 0;
      run.started = false;
      if (run.idx >= run.list.length) {
        if (!run.loop) { finish(run, true); return; }
        run.idx = Math.min(run.loopStart, run.list.length - 1);
        // a loop of only zero-length phases would never consume time: one pass per update
        if (!run.list.slice(run.idx).some((p) => p.duration > 0)) return;
      }
    }
  }

  return {
    get speed() { return speed; },
    set speed(v) { speed = Number.isFinite(v) && v > 0 ? v : 1; },
    play,
    stop,
    update,
    get playing() { return cur !== null; },
    get phaseName() { return cur ? (cur.list[cur.idx].name || "") : ""; },
  };
}
