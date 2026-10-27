import { useEffect, useRef, useState } from 'react';
import { assignRoom, closeSeats, loadScale, openSeats, type Gate, type Seat } from './schoolProbe';

/** Local simulator timings from docs/teacher-dashboard.md. Not a hosted-school measurement. */
const SAMPLES = [
  { learners: 2, ackP50: 3, ackP95: 4 },
  { learners: 10, ackP50: 3, ackP95: 7 },
  { learners: 30, ackP50: 5, ackP95: 6 },
] as const;

// 2026-10-25: the room dots and the 1/0 counts were drawn in the browser and never reached SpacetimeDB.
// const ROOMS = [6, 4, 8, 5, 9, 7, 6, 10, 4, 8, 5, 10].map((learners, index) => ({ id: index + 1, learners }));

const CHART = { w: 280, h: 128, left: 32, right: 12, top: 16, bottom: 28 };
const ACK_MAX_MS = 10;

function ackX(learners: number): number {
  return CHART.left + ((learners - 2) / 28) * (CHART.w - CHART.left - CHART.right);
}

function ackY(ms: number): number {
  return CHART.top + (1 - ms / ACK_MAX_MS) * (CHART.h - CHART.top - CHART.bottom);
}

const ackLine = SAMPLES.map((sample) => `${ackX(sample.learners)},${ackY(sample.ackP50)}`).join(' ');
const zeroY = CHART.h - CHART.bottom;

export default function School() {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [connected, setConnected] = useState(0);
  const [target, setTarget] = useState<number | null>(null);
  const [phase, setPhase] = useState<'connecting' | 'ready' | 'writing' | 'applied' | 'error'>('connecting');
  const [ackMs, setAckMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [database, setDatabase] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const gate = useRef<Gate>({ armed: false });
  const seatsRef = useRef<Seat[]>([]);

  useEffect(() => {
    let cancelled = false;
    const gateRef = gate.current;
    loadScale()
      .then((school) => {
        if (!cancelled) setDatabase(school.database || null);
        return openSeats(school.rooms, gateRef, (ready) => {
          if (!cancelled) setConnected(ready);
        }, () => {
          if (!cancelled) setTick((value) => value + 1);
        });
      })
      .then((opened) => {
        if (cancelled) {
          closeSeats(opened);
          return;
        }
        seatsRef.current = opened;
        setSeats(opened);
        setPhase('ready');
      })
      .catch((exc: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setError(exc instanceof Error ? exc.message : 'The scale rooms could not be opened.');
      });
    return () => {
      cancelled = true;
      gateRef.armed = false;
      closeSeats(seatsRef.current);
    };
  }, []);

  async function assign(id: number) {
    const seat = seatsRef.current.find((item) => item.id === id);
    if (!seat || phase === 'writing' || phase === 'connecting') return;
    for (const item of seatsRef.current) item.updates = 0;
    setTick((value) => value + 1);
    setTarget(id);
    setAckMs(null);
    setError(null);
    setPhase('writing');
    gate.current.armed = true;
    try {
      const ms = await assignRoom(seat);
      setAckMs(ms);
      setPhase('applied');
    } catch (exc) {
      setPhase('error');
      setError(exc instanceof Error ? exc.message : 'The lesson was not saved.');
    } finally {
      gate.current.armed = false;
    }
  }

  const others = seats.filter((seat) => seat.id !== target).reduce((sum, seat) => sum + seat.updates, 0);
  void tick;

  return (
    <section className="school" aria-labelledby="school-title">
      <header className="school-head">
        <p className="school-kicker">Live database</p>
        <h1 id="school-title">One database for the school</h1>
        <p>
          Twelve rooms, each with a teacher subscribed to <span className="school-db">classroom_board</span> and a learner subscribed to <span className="school-db">my_classroom_lesson</span>.
          They are rows in <span className="school-db">{database ?? 'the classroom database'}</span>, separate from the classroom open on the Classroom tab.
        </p>
        <button type="button" className="btn btn--primary" aria-pressed={target === 12} disabled={phase === 'connecting' || phase === 'writing' || seats.length === 0} onClick={() => void assign(12)}>
          {phase === 'connecting' ? `Connecting ${connected} of 24` : phase === 'writing' ? 'Writing' : 'Assign to room 12'}
        </button>
      </header>
      <div className="school-layout">
        <div className="school-board">
          <p className="school-db-bar">One database · {database ?? 'classroom database'}</p>
          <div className="school-rooms" role="list">
            {(seats.length > 0 ? seats : Array.from({ length: 12 }, (_, index) => ({ id: index + 1, classroomId: `scale-${index + 1}`, updates: 0 }))).map((room) => {
              const live = 'teacher' in room;
              const lit = room.updates > 0 && phase !== 'connecting' && phase !== 'ready';
              const dim = (phase === 'applied' || phase === 'error') && target != null && room.updates === 0;
              const count = phase === 'connecting' ? 'Connecting' : phase === 'ready' ? 'Subscribed' : `${room.updates} update${room.updates === 1 ? '' : 's'}`;
              return (
                <div id={`school-room-${room.id}`} key={room.id} className={`school-room${lit ? ' is-lit' : ''}${dim ? ' is-dim' : ''}${live ? ' is-live' : ''}`} role="listitem">
                  <button type="button" aria-label={`Room ${room.id}`} aria-pressed={target === room.id} disabled={!live || phase === 'writing'} onClick={() => void assign(room.id)}>
                    {room.id}
                  </button>
                  <span className="school-dots" aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  <span className="school-count">live</span>
                  <span className="school-updates">{count}</span>
                </div>
              );
            })}
          </div>
          <p className="school-result" role="status">
            {phase === 'connecting' && `Opening subscriptions. ${connected} of 24 are connected.`}
            {phase === 'ready' && 'Each room is subscribed. A write is counted only when that subscription receives a row from the database.'}
            {phase === 'writing' && target != null && `save_lesson is in room ${target}. Waiting for that learner to acknowledge it.`}
            {phase === 'applied' && target != null && ackMs != null && `Room ${target} acknowledged in ${ackMs} ms. Its subscriptions reported ${seats.find((seat) => seat.id === target)?.updates ?? 0} updates. The other rooms reported ${others}.`}
            {phase === 'error' && (error ?? 'The write did not finish.')}
          </p>
        </div>
        <aside className="school-measure" aria-label="Ack timings">
          <h2>This write</h2>
          <p className="school-ack">{ackMs == null ? 'No write yet' : `${ackMs} ms until ack`}</p>
          <h2>Earlier local simulator</h2>
          <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-label="Ack time stays between 3 and 5 milliseconds at 2, 10, and 30 learners.">
            <line x1={CHART.left} y1={ackY(0)} x2={CHART.left} y2={ackY(ACK_MAX_MS)} />
            <line x1={CHART.left} y1={ackY(0)} x2={CHART.w - CHART.right} y2={ackY(0)} />
            <text x={4} y={ackY(ACK_MAX_MS) + 4}>10 ms</text>
            <text x={4} y={ackY(0)}>0</text>
            <polyline points={ackLine} />
            {SAMPLES.map((sample) => (
              <g key={sample.learners}>
                <circle cx={ackX(sample.learners)} cy={ackY(sample.ackP50)} r={4} />
                <text x={ackX(sample.learners)} y={CHART.h - 8} textAnchor="middle">{sample.learners}</text>
              </g>
            ))}
          </svg>
          <ul>
            {SAMPLES.map((sample) => (
              <li key={sample.learners}>{sample.learners} learners · p50 {sample.ackP50} ms · p95 {sample.ackP95} ms</li>
            ))}
          </ul>
          <h2>Updates delivered to every other room</h2>
          <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-label="Other rooms stay at zero updates at 2, 10, and 30 learners.">
            <line x1={CHART.left} y1={CHART.top} x2={CHART.left} y2={zeroY} />
            <line x1={CHART.left} y1={zeroY} x2={CHART.w - CHART.right} y2={zeroY} />
            <text x={4} y={CHART.top + 4}>1</text>
            <text x={4} y={zeroY}>0</text>
            <polyline points={`${ackX(2)},${zeroY} ${ackX(10)},${zeroY} ${ackX(30)},${zeroY}`} />
            {SAMPLES.map((sample) => (
              <g key={sample.learners}>
                <circle cx={ackX(sample.learners)} cy={zeroY} r={4} />
                <text x={ackX(sample.learners)} y={CHART.h - 8} textAnchor="middle">{sample.learners}</text>
              </g>
            ))}
          </svg>
          <p>0 updates at 2, 10, and 30 learners in the room that was written.</p>
          <p className="fine">
            These timings are from a local simulator. They are not a capacity limit for a hosted school.
            This version has one teacher for a classroom. Audio, the articulatory model, and the coaching model stay outside this subscription and scale by adding workers.
          </p>
        </aside>
      </div>
    </section>
  );
}
