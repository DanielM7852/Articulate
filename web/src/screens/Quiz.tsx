import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { QUESTIONS, questionLine } from '../audio/bakedLines';
import { loadSession } from '../classroom/session';
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
import { CaptionBar, useNarration } from '../components/Narration';
import { OnboardingFrame, OptionCard, Segmented, StepHeading, useStepNav } from '../components/Onboarding';
import { proposeLessonPlan } from '../services/coach';
import { useAppState } from '../state/AppState';
import type { Goal, Guidance, Pace, Routine, Support } from '../state/types';

/**
 * Three questions, read aloud by the guide with the text shown underneath.
 * Nothing is pre-selected and Continue stays off until the learner answers, so
 * every preference the coach later personalises on is a real choice.
 */
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

type Step = keyof typeof QUESTIONS;
const isStep = (n: number): n is Step => n === 1 || n === 2 || n === 3;

export default function Quiz() {
  const { step: raw } = useParams();
  const step = Number(raw);
  const go = useStepNav();
  const { preferences, updatePreferences, updatePlan, completeQuiz, plan, skipClassroomSurvey } = useAppState();
  const narration = useNarration();
  const [saving, setSaving] = useState(false);
  const classroomLearner = loadSession()?.role === 'learner';

  useEffect(() => {
    if (classroomLearner) skipClassroomSurvey();
  }, [classroomLearner, skipClassroomSurvey]);

  useEffect(() => {
    if (!isStep(step)) return;
    narration.say(questionLine(step));
  }, [step, narration.say]);

  if (classroomLearner) return <Navigate to="/practice" replace />;
  if (!isStep(step)) return <Navigate to="/quiz/1" replace />;

  const answered =
    step === 1
      ? preferences.goals.length > 0
      : step === 2
        ? preferences.routine !== null && preferences.pace !== null
        : preferences.support !== null && preferences.guidance !== null;

  const next = () => {
    if (step < 3) return go(`/quiz/${step + 1}`);
    // 2026-10-24: pace and guidance alone set the plan.
    // updatePlan({
    //   pace: preferences.pace ?? 'unhurried',
    //   assistance: preferences.guidance === 'explore' ? 'target-only' : 'cue-target',
    // });
    setSaving(true);
    void proposeLessonPlan(preferences, plan.sound).then((nextPlan) => {
      updatePlan(nextPlan);
      completeQuiz();
      setSaving(false);
      go('/lesson');
    });
  };
  const back = () => go(step > 1 ? `/quiz/${step - 1}` : '/', 'back');

  const toggleGoal = (g: Goal) => {
    const has = preferences.goals.includes(g);
    updatePreferences({ goals: has ? preferences.goals.filter((x) => x !== g) : [...preferences.goals, g] });
  };

  const q = QUESTIONS[step];

  return (
    <OnboardingFrame
      step={step}
      width={720}
      onBack={back}
      caption={<CaptionBar text={narration.caption} />}
      primary={{ label: saving ? 'Choosing a start…' : 'Continue', onClick: next, disabled: !answered || saving }}
    >
      <StepHeading title={q.title} hint={q.hint} />

      {step === 1 && (
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
      )}

      {step === 2 && (
        <>
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
            <Segmented label="Pace" options={PACES} value={preferences.pace ?? undefined} onChange={(pace) => updatePreferences({ pace })} />
            <p className="ob-fine ob-hide-short" aria-live="polite">
              {preferences.pace ? PACE_NOTES[preferences.pace] : 'Choose one to continue.'}
            </p>
          </div>
        </>
      )}

      {step === 3 && (
        <>
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
              value={preferences.guidance ?? undefined}
              onChange={(guidance) => updatePreferences({ guidance })}
            />
          </div>
        </>
      )}
    </OnboardingFrame>
  );
}
