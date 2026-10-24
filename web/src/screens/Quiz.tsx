import { Navigate, useParams } from 'react-router-dom';
import {
  AudioLines,
  CalendarDays,
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
  type LucideIcon,
} from 'lucide-react';
import { OnboardingFrame, OptionCard, Segmented, StepHeading, useStepNav } from '../components/Onboarding';
import { useAppState } from '../state/AppState';
import type { Goal, Guidance, Pace, Routine, Support } from '../state/types';

const GOALS: { id: Goal; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'conversations', title: 'Everyday conversations', text: 'A hello, a catch-up, ordering your usual.', icon: MessagesSquare },
  { id: 'sounds', title: 'Particular sounds', text: 'Explore a sound that interests you.', icon: AudioLines },
  { id: 'longer', title: 'Speaking for longer', text: 'A comfortable rhythm for longer moments.', icon: Timer },
  { id: 'visual', title: 'Visual practice', text: 'Discover what it’s like to see a sound.', icon: ScanEye },
];

const ROUTINES: { id: Routine; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'exploring', title: 'Just exploring', text: 'Curious and finding my way.', icon: Compass },
  { id: 'occasional', title: 'Now and then', text: 'When it feels right.', icon: Coffee },
  { id: 'regular', title: 'A regular routine', text: 'Practice is part of my week.', icon: CalendarDays },
  { id: 'partner', title: 'With someone', text: 'A person I trust joins me.', icon: Users },
];

const PACES: { id: Pace; label: string }[] = [
  { id: 'unhurried', label: 'Unhurried' },
  { id: 'steady', label: 'Steady' },
  { id: 'flexible', label: 'Flexible' },
];

const PACE_NOTES: Record<Pace, string> = {
  unhurried: 'A little more time between prompts.',
  steady: 'A consistent rhythm between prompts.',
  flexible: 'You choose when to move on each time.',
};

const SUPPORTS: { id: Support; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'mouth', title: 'Watching the mouth', text: 'Show me a visual reference.', icon: ScanFace },
  { id: 'words', title: 'Seeing the words', text: 'A clear written prompt.', icon: Type },
  { id: 'hear', title: 'Hearing an example', text: 'I choose when to listen.', icon: Volume2 },
  { id: 'self', title: 'Trying it myself', text: 'Let me explore first.', icon: Mic },
];

const GUIDANCE: { id: Guidance; label: string }[] = [
  { id: 'guided', label: 'A little guidance' },
  { id: 'explore', label: 'Room to explore' },
];

export default function Quiz() {
  const { step: raw } = useParams();
  const step = Number(raw);
  const go = useStepNav();
  const { preferences, updatePreferences, updatePlan } = useAppState();

  if (![1, 2, 3].includes(step)) return <Navigate to="/quiz/1" replace />;

  const next = () => {
    if (step < 3) return go(`/quiz/${step + 1}`);
    updatePlan({
      pace: preferences.pace,
      assistance: preferences.guidance === 'guided' ? 'cue-target' : 'target-only',
    });
    go('/setup');
  };
  const back = () => go(step > 1 ? `/quiz/${step - 1}` : '/welcome', 'back');

  const toggleGoal = (g: Goal) => {
    const has = preferences.goals.includes(g);
    updatePreferences({ goals: has ? preferences.goals.filter((x) => x !== g) : [...preferences.goals, g] });
  };

  return (
    <OnboardingFrame step={step} width={720} onBack={back} primary={{ label: 'Continue', onClick: next }}>
      {step === 1 && (
        <>
          <StepHeading title="What would you like to feel more comfortable with?" hint="Pick as many as you like." />
          <div className="ob-options" role="group" aria-label="Goals">
            {GOALS.map((g) => (
              <OptionCard
                key={g.id}
                multi
                title={g.title}
                description={g.text}
                icon={<g.icon size={22} />}
                checked={preferences.goals.includes(g.id)}
                onToggle={() => toggleGoal(g.id)}
              />
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <StepHeading title="Which sounds most like your routine?" hint="No experience needed. We’ll meet you where you are." />
          <div className="ob-options" role="radiogroup" aria-label="Routine">
            {ROUTINES.map((r) => (
              <OptionCard
                key={r.id}
                title={r.title}
                description={r.text}
                icon={<r.icon size={22} />}
                checked={preferences.routine === r.id}
                onToggle={() => updatePreferences({ routine: r.id })}
              />
            ))}
          </div>
          <div className="stack gap-10">
            <p className="ob-label">A comfortable pace</p>
            <Segmented label="Pace" options={PACES} value={preferences.pace} onChange={(pace) => updatePreferences({ pace })} />
            <p className="ob-fine ob-hide-short" aria-live="polite">
              {PACE_NOTES[preferences.pace]}
            </p>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <StepHeading title="When a sound feels new, what helps you start?" hint="You can try the other ways too." />
          <div className="ob-options" role="radiogroup" aria-label="Support">
            {SUPPORTS.map((s) => (
              <OptionCard
                key={s.id}
                title={s.title}
                description={s.text}
                icon={<s.icon size={22} />}
                checked={preferences.support === s.id}
                onToggle={() => updatePreferences({ support: s.id })}
              />
            ))}
          </div>
          <div className="stack gap-10">
            <p className="ob-label">With new sounds, I prefer</p>
            <Segmented
              label="With new sounds, I prefer"
              options={GUIDANCE}
              value={preferences.guidance}
              onChange={(guidance) => updatePreferences({ guidance })}
            />
          </div>
        </>
      )}
    </OnboardingFrame>
  );
}
