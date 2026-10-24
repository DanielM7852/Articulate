import { memo } from 'react';
import type { WordZone, ZoneKind } from '../../game/types';
import type { ZoneStatus } from '../../game/sequence';

const STATE_TEXT: Record<ZoneStatus, string> = {
  upcoming: 'next',
  active: 'now',
  hit: 'landed',
  partial: 'close',
  miss: 'not yet',
  skipped: 'skipped',
};

/** Small mark under each letter saying what kind of target it is. */
function KindGlyph({ kind, flashKey }: { kind: ZoneKind; flashKey: string }) {
  if (kind === 'stop') {
    // Closure (two bars touching) that parts on a detected release burst.
    return (
      <span key={flashKey} className={`wb-glyph wb-glyph--stop${flashKey ? ' is-flash' : ''}`}>
        <span className="wb-stop-half" />
        <span className="wb-stop-spark" />
        <span className="wb-stop-half" />
      </span>
    );
  }
  if (kind === 'tuner') {
    return (
      <span className="wb-glyph wb-glyph--tuner">
        <span className="wb-glyph-meter" />
      </span>
    );
  }
  return (
    <span className="wb-glyph wb-glyph--vowel">
      <span className="wb-glyph-ellipse" />
    </span>
  );
}

/**
 * The word spelled as zone chips ("t r a ck"), left to right. Each chip shows its state
 * by colour, a badge and border style (not colour alone), and announces changes politely.
 */
export const ZoneSequence = memo(function ZoneSequence({
  word,
  zones,
  statuses,
  activeIndex,
  focusZoneId,
  flash,
  announce,
}: {
  word: string;
  zones: WordZone[];
  statuses: ZoneStatus[];
  activeIndex: number;
  focusZoneId: string | null;
  flash: string[];
  /** Announce state changes (live attempts only; the looping demo would chatter). */
  announce: boolean;
}) {
  return (
    <ol className="wb-zones" aria-label={`Sounds in “${word}”`}>
      {zones.map((zone, i) => {
        const state = statuses[i] ?? 'upcoming';
        return (
          <li
            key={zone.id}
            className="wb-chip"
            data-kind={zone.kind}
            data-state={state}
            data-active={i === activeIndex}
            data-focus={zone.id === focusZoneId}
          >
            <span className="wb-chip-letter" aria-hidden="true">
              {zone.label}
            </span>
            <KindGlyph kind={zone.kind} flashKey={flash[i] ?? ''} />
            <span className="wb-chip-badge" aria-hidden="true" />
            <span className="sr-only" aria-live={announce ? 'polite' : 'off'}>
              {zone.label}: {STATE_TEXT[state]}
            </span>
          </li>
        );
      })}
    </ol>
  );
});
