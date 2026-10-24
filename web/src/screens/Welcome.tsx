import { useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, SlidersHorizontal, VolumeX } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Badge, Button } from '../components/ui';
import { SoundContours } from '../components/practice';

const BENEFITS = [
  { icon: Eye, title: 'Visual first', text: 'See sound patterns and explore a mouth reference.' },
  { icon: VolumeX, title: 'Sound is optional', text: 'Every instruction and example has a text caption.' },
  { icon: SlidersHorizontal, title: 'Always your choice', text: 'Adjust support, take a break, or change your preferences later.' },
];

export default function Welcome() {
  const navigate = useNavigate();

  return (
    <AppShell context="Welcome">
      <div className="welcome">
        <section className="stack gap-28" style={{ maxWidth: 560 }}>
          <Badge>A gentle start · About 2 minutes</Badge>
          <h1 className="display-xl">Find a starting point that feels like you.</h1>
          <p className="lede">
            Explore spoken communication through visual practice, at your own pace. A few simple choices will help us
            suggest the support you’d like to begin with.
          </p>
          <ul className="stack gap-20" style={{ listStyle: 'none', padding: '6px 0', margin: 0 }}>
            {BENEFITS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="row row--top" style={{ gap: 16 }}>
                <Icon size={23} color="var(--color-navy)" aria-hidden="true" />
                <span className="stack gap-4">
                  <span className="ink strong" style={{ fontSize: 15 }}>
                    {title}
                  </span>
                  <span className="small">{text}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="stack gap-14" style={{ alignItems: 'flex-start' }}>
            <Button variant="primary" icon={<ArrowRight size={17} aria-hidden="true" />} onClick={() => navigate('/quiz/1')}>
              Start
            </Button>
          </div>
        </section>

        <aside className="panel-navy welcome-panel" aria-label="What practice looks like">
          <p className="eyebrow">A little clarity. Your own voice.</p>
          <div className="stack gap-24">
            <div className="row row--between wrap" style={{ gap: 24 }}>
              <p className="serif" style={{ fontSize: 108, lineHeight: 1 }}>
                /i/
              </p>
              <div className="stack gap-8" style={{ width: 236 }}>
                <p className="serif" style={{ fontSize: 28 }}>
                  ee · as in see
                </p>
                <p className="on-navy-muted small" style={{ color: 'var(--color-navy-mist)' }}>
                  A sound to watch, explore, and try. No pressure to get it perfect.
                </p>
              </div>
            </div>
            <div className="stack gap-14" style={{ background: 'var(--color-navy-deep)', borderRadius: 12, padding: 22 }}>
              <div className="row row--between fine" style={{ color: 'var(--color-navy-mist)' }}>
                <span>A visual way to explore your sound</span>
                <span>Illustration</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <SoundContours />
              </div>
              <p className="fine" style={{ color: 'var(--color-ivory)' }}>
                Watch a reference. Try a sound. Find what helps.
              </p>
            </div>
            <p className="serif" style={{ fontSize: 30, lineHeight: 1.28 }}>
              Small steps. Room to explore.
            </p>
          </div>
          <p className="fine" style={{ color: 'var(--color-navy-mist)', lineHeight: 1.7 }}>
            For deaf and hard-of-hearing people who choose spoken communication. Your communication choices are always
            yours.
          </p>
        </aside>
      </div>
    </AppShell>
  );
}
