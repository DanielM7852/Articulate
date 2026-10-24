import { memo, type Ref } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { WordZone } from '../../game/types';
import type { ZoneStatus } from '../../game/sequence';
import { needlePosition } from '../../game/scoring';

/**
 * Vertical needle meter for a tuner zone (f3gap for r). Static markup only: the board's
 * frame loop moves `needleRef` (translateY in % of the meter) and `fillRef` (scaleY of the
 * band's hold fill), and toggles `data-inband` / `data-live` on `stripRef`. No numbers are
 * drawn: the learner sees a needle, a green band and which way to push.
 */
export const TunerStrip = memo(function TunerStrip({
  zone,
  open,
  focus,
  status,
  stripRef,
  needleRef,
  fillRef,
}: {
  zone: WordZone | null;
  open: boolean;
  focus: boolean;
  status: ZoneStatus | null;
  stripRef: Ref<HTMLDivElement>;
  needleRef: Ref<HTMLDivElement>;
  fillRef: Ref<HTMLDivElement>;
}) {
  const tuner = zone?.tuner;
  const bandBottom = tuner ? needlePosition(tuner.lowHz, tuner) * 100 : 0;
  const bandTop = tuner ? needlePosition(tuner.highHz, tuner) * 100 : 0;
  const Arrow = tuner?.pushTo === 'high' ? ArrowUp : ArrowDown;

  return (
    <div
      className="wb-tuner"
      ref={stripRef}
      data-open={open && Boolean(tuner)}
      data-focus={focus}
      data-state={status ?? 'upcoming'}
      data-push={tuner?.pushTo ?? 'low'}
      aria-hidden="true"
    >
      <span className="wb-tuner-label">{zone?.label ?? ''}</span>
      <div className="wb-tuner-body">
        <div className="wb-meter-wrap">
          <div className="wb-meter">
            <div className="wb-meter-band" style={{ bottom: `${bandBottom}%`, height: `${bandTop - bandBottom}%` }}>
              <div className="wb-meter-fill" ref={fillRef} />
            </div>
          </div>
          {/* Outside the clipped meter so the needle can overhang both edges. */}
          <div className="wb-needle-track" ref={needleRef}>
            <div className="wb-needle" />
          </div>
        </div>
        <span className="wb-tuner-arrow">
          <Arrow size={22} strokeWidth={2.5} />
        </span>
      </div>
      <p className="wb-tuner-hint">{zone?.hint ?? ''}</p>
    </div>
  );
});
