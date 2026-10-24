import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  CalendarDays,
  Check,
  Coffee,
  Compass,
  MessagesSquare,
  Mic,
  ScanEye,
  ScanFace,
  Timer,
  Type,
  Users,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { SoundContours } from '../components/practice';
import { Button, ChoiceButton, ChoiceCard } from '../components/ui';
import { useAppState } from '../state/AppState';
import type { Goal, Pace, Routine, Support } from '../state/types';

const STEPS = ['What matters to you', 'A little about your routine', 'How you like to begin'];

const GOALS: { id: Goal; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'conversations', title: 'Everyday conversations', text: 'A hello, a catch-up, or ordering your usual.', icon: MessagesSquare },
  { id: 'sounds', title: 'Particular sounds', text: 'Make space to explore a sound that interests you.', icon: AudioLines },
  { id: 'longer', title: 'Speaking for longer', text: 'Build a comfortable rhythm for longer moments.', icon: Timer },
  { id: 'visual', title: 'Exploring visual practice', text: 'Discover what it’s like to see a sound.', icon: ScanEye },
];

const ROUTINES: { id: Routine; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'exploring', title: 'Just exploring', text: 'I’m curious and finding my way.', icon: Compass },
  { id: 'occasional', title: 'Occasional practice', text: 'I make time when it feels right.', icon: Coffee },
  { id: 'regular', title: 'A regular routine', text: 'Practice is part of my week.', icon: CalendarDays },
  { id: 'partner', title: 'Practicing with someone', text: 'I explore with a person I trust.', icon: Users },
];

const PACES: { id: Pace; label: string }[] = [
  { id: 'unhurried', label: 'Unhurried' },
  { id: 'steady', label: 'Steady' },
  { id: 'flexible', label: 'I’ll decide as I go' },
];

const SUPPORTS: { id: Support; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'mouth', title: 'Watching a mouth movement', text: 'Show me a visual reference.', icon: ScanFace },
  { id: 'words', title: 'Seeing the words', text: 'Give me a clear written prompt.', icon: Type },
  { id: 'hear', title: 'Hearing an example', text: 'Let me choose when to listen.', icon: Volume2 },
  { id: 'self', title: 'Trying it myself', text: 'Let me explore before a cue.', icon: Mic },
];

function GoalMedia({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.35 }}>
        <SoundContours width={300} height={92} />
      </span>
      <Icon size={34} strokeWidth={1.5} color="var(--color-ivory)" style={{ position: 'relative' }} />
    </>
  );
}

export default function Quiz() {
  const { step: raw } = useParams();
  const step = Number(raw);
  const navigate = useNavigate();
  const { preferences, updatePreferences, setNarration, narration, updatePlan } = useAppState();

  if (![1, 2, 3].includes(step)) return <Navigate to="/quiz/1" replace />;

  const next = () => {
    if (step < 3) navigate(`/quiz/${step + 1}`);
    else {
      updatePlan({
        pace: preferences.pace,
        assistance: preferences.guidance === 'guided' ? 'cue-target' : 'target-only',
      });
      navigate('/setup');
    }
  };
  const back = () => (step > 1 ? navigate(`/quiz/${step - 1}`) : navigate('/welcome'));

  const toggleGoal = (g: Goal) => {
    const has = preferences.goals.includes(g);
    updatePreferences({ goals: has ? preferences.goals.filter((x) => x !== g) : [...preferences.goals, g] });
  };

  const selectedGoalNames = GOALS.filter((g) => preferences.goals.includes(g.id)).map((g) => g.title.toLowerCase());

  return (
    <AppShell context="Your starting point">
      <div className="quiz-layout">
        <aside className="journey" aria-label="Your progress">
          <div className="stack gap-24">
            <p className="eyebrow">{step === 3 ? 'Your start' : 'A start that fits you'}</p>
            <p className="serif" style={{ fontSize: 29, lineHeight: 1.28 }}>
              {step === 3 ? 'Start with what feels right.' : 'There’s no right way to begin.'}
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-navy-mist)' }}>
              A few preferences help us suggest a starting point. These aren’t test questions.
            </p>
            <ol className="journey-steps">
              {STEPS.map((label, i) => {
                const n = i + 1;
                return (
                  <li key={label} className="journey-step" aria-current={n === step ? 'step' : undefined}>
                    <span className="journey-marker">{n < step ? <Check size={12} aria-label="done" /> : n}</span>
                    {label}
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="stack gap-14">
            <hr className="rule rule--navy" />
            <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-navy-mist)' }}>
              You can change your choices later. Captions stay available throughout.
            </p>
          </div>
        </aside>

        <section className="question" aria-labelledby="q-title">
          <div className="stack gap-24">
            <div className="row row--between">
              <p className="eyebrow">Your preferences</p>
              <p className="small">Question {step} of 3</p>
            </div>
            <div className="progress-bar" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <span key={n} className={n <= step ? 'done' : ''} />
              ))}
            </div>

            {step === 1 && (
              <>
                <div className="stack gap-14">
                  <h1 id="q-title" className="display-md">
                    What would you like to feel more comfortable with?
                  </h1>
                  <p className="body">Choose the things that matter to you. You can pick more than one.</p>
                </div>
                <div className="grid-2" style={{ gap: 16 }} role="group" aria-labelledby="q-title">
                  {GOALS.map((g) => (
                    <ChoiceCard
                      key={g.id}
                      multi
                      title={g.title}
                      description={g.text}
                      media={<GoalMedia icon={g.icon} />}
                      checked={preferences.goals.includes(g.id)}
                      onToggle={() => toggleGoal(g.id)}
                    />
                  ))}
                </div>
                <p className="small navy" aria-live="polite">
                  {selectedGoalNames.length
                    ? `${selectedGoalNames.length} selected · ${selectedGoalNames.join(' + ')}`
                    : 'Nothing selected yet. That’s fine too.'}
                </p>
              </>
            )}

            {step === 2 && (
              <>
                <div className="stack gap-14">
                  <h1 id="q-title" className="display-md">
                    Which sounds most like your routine?
                  </h1>
                  <p className="body">There’s no experience you need to bring. We’ll meet you where you are.</p>
                </div>
                <div className="grid-2" style={{ gap: 14 }} role="radiogroup" aria-labelledby="q-title">
                  {ROUTINES.map((r) => (
                    <ChoiceCard
                      key={r.id}
                      title={r.title}
                      description={r.text}
                      icon={<r.icon size={24} />}
                      checked={preferences.routine === r.id}
                      onToggle={() => updatePreferences({ routine: r.id })}
                    />
                  ))}
                </div>
                <div className="stack gap-14" style={{ paddingTop: 16 }}>
                  <div className="row row--between">
                    <p className="eyebrow" id="pace-label">
                      A pace that feels comfortable
                    </p>
                    <p className="fine">Optional</p>
                  </div>
                  <div className="btn-row" role="group" aria-labelledby="pace-label">
                    {PACES.map((p) => (
                      <ChoiceButton key={p.id} selected={preferences.pace === p.id} onClick={() => updatePreferences({ pace: p.id })}>
                        {p.label}
                      </ChoiceButton>
                    ))}
                  </div>
                  <p className="fine">
                    {preferences.pace === 'unhurried'
                      ? 'Unhurried leaves a little more time between prompts.'
                      : preferences.pace === 'steady'
                        ? 'Steady keeps a consistent rhythm between prompts.'
                        : 'You choose when to move on each time.'}
                  </p>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="stack gap-14">
                  <h1 id="q-title" className="display-md">
                    When a sound feels unfamiliar, what helps you start?
                  </h1>
                  <p className="body">Choose the support you’d reach for first. You’ll be able to try other ways too.</p>
                </div>
                <div className="grid-2" style={{ gap: 14 }} role="radiogroup" aria-labelledby="q-title">
                  {SUPPORTS.map((s) => (
                    <ChoiceCard
                      key={s.id}
                      title={s.title}
                      description={s.text}
                      icon={<s.icon size={24} />}
                      checked={preferences.support === s.id}
                      onToggle={() => updatePreferences({ support: s.id })}
                    />
                  ))}
                </div>
                <div className="row row--between wrap" style={{ paddingTop: 8 }}>
                  <p className="ink" style={{ fontSize: 14 }} id="guidance-label">
                    With new sounds, I prefer…
                  </p>
                  <div className="btn-row" role="group" aria-labelledby="guidance-label">
                    <ChoiceButton selected={preferences.guidance === 'guided'} onClick={() => updatePreferences({ guidance: 'guided' })}>
                      A little guidance
                    </ChoiceButton>
                    <ChoiceButton selected={preferences.guidance === 'explore'} onClick={() => updatePreferences({ guidance: 'explore' })}>
                      Room to explore
                    </ChoiceButton>
                  </div>
                </div>
                <div className="row row--between wrap" style={{ background: 'var(--color-navy-soft)', borderRadius: 6, padding: 16 }}>
                  <div className="stack gap-4">
                    <p className="navy strong" style={{ fontSize: 13 }}>
                      Captions always available
                    </p>
                    <p className="fine">Narration is optional, not required.</p>
                  </div>
                  <Button
                    size="sm"
                    aria-pressed={narration}
                    icon={narration ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
                    onClick={() => setNarration(!narration)}
                  >
                    Narration {narration ? 'on' : 'off'}
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="row row--between" style={{ paddingTop: 24 }}>
            <Button icon={<ArrowLeft size={17} aria-hidden="true" />} onClick={back}>
              Back
            </Button>
            <div className="row" style={{ gap: 22 }}>
              <button type="button" className="text-link muted" onClick={() => navigate('/setup')}>
                Skip for now
              </button>
              <Button variant="primary" icon={<ArrowRight size={17} aria-hidden="true" />} onClick={next}>
                {step === 3 ? 'Set up practice' : 'Continue'}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
