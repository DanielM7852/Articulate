import { ArrowRight, Captions, Eye, SlidersHorizontal } from 'lucide-react';
import { OnboardingFrame, StepHeading, useStepNav } from '../components/Onboarding';
import { SoundContours } from '../components/practice';

const BENEFITS = [
  { icon: Eye, label: 'Visual first' },
  { icon: Captions, label: 'Sound is optional' },
  { icon: SlidersHorizontal, label: 'Change anything later' },
];

export default function Welcome() {
  const go = useStepNav();

  return (
    <OnboardingFrame
      step={0}
      className="ob-welcome"
      primary={{ label: 'Get started', icon: <ArrowRight size={18} aria-hidden="true" />, onClick: () => go('/quiz/1') }}
    >
      <div className="ob-hero" aria-hidden="true">
        <SoundContours width={112} height={52} />
        <span>/i/</span>
      </div>
      <StepHeading
        eyebrow="A gentle start · about 2 minutes"
        title="Find a starting point that feels like you."
        hint="Visual speech practice for deaf and hard-of-hearing people who choose spoken communication, at your own pace."
      />
      <ul className="ob-chips" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {BENEFITS.map(({ icon: Icon, label }) => (
          <li key={label} className="ob-chip">
            <Icon size={16} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </OnboardingFrame>
  );
}
