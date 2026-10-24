import { useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Pace, type SoundId } from '../state/types';
import { assistanceLabel } from '../services/coach';

export function LessonHeader({
  eyebrow,
  assistanceNote,
  disabled,
  onSoundChange,
}: {
  eyebrow: string;
  assistanceNote?: string;
  disabled?: boolean;
  onSoundChange?: (s: SoundId) => void;
}) {
  const { plan, updatePlan } = useAppState();
  const s = SOUNDS[plan.sound];
  return (
    <div className="row row--between wrap" style={{ gap: 16 }}>
      <div className="stack gap-8">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="display-sm">
          Find your {s.spelled} <span className="accent">{s.ipa}</span>
        </h1>
      </div>
      <div className="stack gap-10" style={{ alignItems: 'flex-end' }}>
        <div className="btn-row" style={{ gap: 8 }} role="group" aria-label="Choose a sound">
          {SOUND_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn--sm btn--choice"
              aria-pressed={plan.sound === id}
              disabled={disabled && plan.sound !== id}
              onClick={() => {
                updatePlan({ sound: id });
                onSoundChange?.(id);
              }}
            >
              {SOUNDS[id].ipa}&nbsp; {SOUNDS[id].spelled}
            </button>
          ))}
          <select
            className="btn btn--sm"
            aria-label="Pace"
            value={plan.pace}
            disabled={disabled}
            onChange={(e) => updatePlan({ pace: e.target.value as Pace })}
          >
            <option value="unhurried">Pace: unhurried</option>
            <option value="steady">Pace: steady</option>
            <option value="flexible">Pace: as I go</option>
          </select>
        </div>
        <p className="fine">Assistance: {assistanceNote ?? assistanceLabel(plan.assistance).toLowerCase()}</p>
      </div>
    </div>
  );
}
