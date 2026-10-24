import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Button } from '../components/ui';
import { useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Assistance, type Pace } from '../state/types';

const LESSON_STAGES = ['Look at the sound', 'Try it on your own', 'Use a cue, then try again', 'Try with less help'];

export default function Plan() {
  const navigate = useNavigate();
  const { plan, updatePlan, captions, narration, camera, preferences } = useAppState();
  const s = SOUNDS[plan.sound];
  const guided = preferences.guidance === 'guided';

  return (
    <AppShell context="Your suggested plan">
      <div className="plan">
        <section className="stack gap-32">
          <p className="eyebrow">A gentle starting point</p>
          <h1 className="display-lg">{guided ? 'Start with a little guidance.' : 'Start with room to explore.'}</h1>
          <p className="body" style={{ fontSize: 16 }}>
            We’ve created a gentle starting point based on your preferences. Start with a clear visual reference, then try
            on your own when you’re ready.
          </p>

          <div className="card" style={{ borderRadius: 16 }}>
            <div className="row row--top wrap" style={{ gap: 24 }}>
              <label className="field" style={{ minWidth: 220 }}>
                <span className="eyebrow">Your pace</span>
                <select
                  className="btn"
                  value={plan.pace}
                  onChange={(e) => updatePlan({ pace: e.target.value as Pace })}
                >
                  <option value="unhurried">Unhurried</option>
                  <option value="steady">Steady</option>
                  <option value="flexible">I’ll decide as I go</option>
                </select>
              </label>
              <label className="field" style={{ minWidth: 240 }}>
                <span className="eyebrow">Starting assistance</span>
                <select
                  className="btn"
                  value={plan.assistance}
                  onChange={(e) => updatePlan({ assistance: e.target.value as Assistance })}
                >
                  <option value="cue-target">Visual cues + target</option>
                  <option value="target-only">Target only</option>
                  <option value="none">No cues</option>
                </select>
              </label>
            </div>
            <p className="small">
              Captions {captions ? 'on' : 'off'} · Narration {narration ? 'on' : 'off'} · Camera {camera ? 'on' : 'off'}
            </p>
          </div>

          <div className="stack gap-20">
            <div className="row row--between">
              <p className="eyebrow" id="vowels-h">
                Begin with sustained vowels
              </p>
              <p className="fine">About 5 min each</p>
            </div>
            <div className="grid-3" role="radiogroup" aria-labelledby="vowels-h">
              {SOUND_ORDER.map((id, i) => {
                const v = SOUNDS[id];
                const selected = plan.sound === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="choice sound-choice"
                    onClick={() => updatePlan({ sound: id })}
                  >
                    <span className="serif navy" style={{ fontSize: 32, lineHeight: 1.2 }}>
                      {v.ipa}
                    </span>
                    <span className="ink" style={{ fontSize: 14 }}>
                      {v.spelled} · {v.example}
                    </span>
                    <span className={`strong ${selected ? 'navy' : ''}`} style={{ fontSize: 12, color: selected ? undefined : 'var(--color-muted)' }}>
                      {selected ? 'Start here' : i === 0 ? 'Suggested first' : 'Next'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="btn-row" style={{ gap: 12 }}>
            <Button variant="primary" icon={<ArrowRight size={17} aria-hidden="true" />} onClick={() => navigate('/practice')}>
              Start first lesson
            </Button>
            <Button onClick={() => navigate('/quiz/1')}>Revisit preferences</Button>
          </div>
          <p className="fine">
            This is a suggested starting point based on your preferences. Try it, then adjust support as you go.
          </p>
        </section>

        <aside className="panel-navy" style={{ borderRadius: 24, padding: 32 }} aria-label="Your first lesson">
          <div className="stack gap-28">
            <p className="eyebrow">Your first lesson</p>
            <p className="serif" style={{ fontSize: 32, lineHeight: 1.28 }}>
              Explore one sound, step by step.
            </p>
            <p className="serif" style={{ fontSize: 100, lineHeight: 1 }}>
              {s.ipa}
            </p>
            <ol className="stack gap-24" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {LESSON_STAGES.map((t, i) => (
                <li key={t} className="row row--top" style={{ gap: 14 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-navy-mist)', paddingTop: 3 }}>0{i + 1}</span>
                  <span style={{ fontSize: 14 }}>{t}</span>
                </li>
              ))}
            </ol>
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-navy-mist)' }}>
            You decide what feels helpful. No pass or fail. Switch sounds anytime.
          </p>
        </aside>
      </div>
    </AppShell>
  );
}
