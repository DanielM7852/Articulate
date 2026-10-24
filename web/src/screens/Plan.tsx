import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { OnboardingFrame, Segmented, StepHeading, Switch, useStepNav } from '../components/Onboarding';
import { useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Assistance, type Pace } from '../state/types';

const PACES: { id: Pace; label: string }[] = [
  { id: 'unhurried', label: 'Unhurried' },
  { id: 'steady', label: 'Steady' },
  { id: 'flexible', label: 'Flexible' },
];

const ASSISTANCE: { id: Assistance; label: string }[] = [
  { id: 'cue-target', label: 'With cues' },
  { id: 'target-only', label: 'Target only' },
  { id: 'none', label: 'No cues' },
];

export default function Plan() {
  const navigate = useNavigate();
  const go = useStepNav();
  const { plan, updatePlan, narration, setNarration, preferences, completeOnboarding } = useAppState();
  const guided = preferences.guidance === 'guided';

  return (
    <OnboardingFrame
      step={6}
      onBack={() => go('/setup', 'back')}
      primary={{
        label: 'Start first lesson',
        icon: <ArrowRight size={18} aria-hidden="true" />,
        onClick: () => {
          completeOnboarding();
          navigate('/practice');
        },
      }}
    >
      <StepHeading
        eyebrow={
          <>
            <Check size={15} strokeWidth={3} aria-hidden="true" /> You’re all set
          </>
        }
        title={guided ? 'Start with a little guidance.' : 'Start with room to explore.'}
        hint="One sound, four short steps, about 5 minutes. No pass or fail."
      />

      <div className="ob-sounds" role="radiogroup" aria-label="First sound">
        {SOUND_ORDER.map((id, i) => {
          const v = SOUNDS[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={plan.sound === id}
              className="ob-sound"
              onClick={() => updatePlan({ sound: id })}
            >
              {i === 0 && <span className="ob-sound-tag">Suggested</span>}
              <span className="ob-sound-ipa">{v.ipa}</span>
              <span className="ob-sound-word">
                {v.spelled} · {v.example}
              </span>
            </button>
          );
        })}
      </div>

      <div className="ob-group">
        <div className="ob-row">
          <span className="ob-label">Pace</span>
          <Segmented label="Pace" options={PACES} value={plan.pace} onChange={(pace) => updatePlan({ pace })} />
        </div>
        <div className="ob-row">
          <span className="ob-label">Starting support</span>
          <Segmented
            label="Starting support"
            options={ASSISTANCE}
            value={plan.assistance}
            onChange={(assistance) => updatePlan({ assistance })}
          />
        </div>
        <div className="ob-row ob-row--inline">
          <span className="ob-row-copy">
            <span className="ob-label">Spoken narration</span>
            <span className="ob-fine">Captions stay on either way.</span>
          </span>
          <Switch label="Spoken narration" checked={narration} onChange={setNarration} />
        </div>
      </div>
    </OnboardingFrame>
  );
}
