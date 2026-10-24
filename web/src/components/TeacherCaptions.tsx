import { useEffect, useState } from 'react';
import type { TeacherSpeech } from '../audio/teacher';
import './teacherCaptions.css';

// Shows the spoken line with the current word highlighted. Re-renders on 'word' events only.
export function TeacherCaptions(props: { speech: TeacherSpeech | null; text: string; className?: string }) {
  const { speech, text, className } = props;
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    setCurrent(-1);
    if (!speech) return undefined;
    const offWord = speech.on('word', (i) => setCurrent(i));
    const offEnd = speech.on('end', () => setCurrent(-1));
    return () => {
      offWord();
      offEnd();
    };
  }, [speech]);

  const words = speech && speech.text === text ? speech.words : [];
  const timed = words.length > 0 && current >= 0;

  // Align timed words to the display text; the live-region copy below carries the full line once.
  let body: JSX.Element | string = text;
  if (timed) {
    const pieces = text.split(/(\s+)/);
    let w = -1;
    body = (
      <>
        {pieces.map((piece, i) => {
          if (/^\s*$/.test(piece)) return piece;
          w += 1;
          const state = w === current ? 'current' : w > current ? 'upcoming' : 'past';
          return (
            <span
              key={i}
              className={`teacher-captions__word teacher-captions__word--${state}`}
              aria-current={state === 'current' ? 'true' : undefined}
            >
              {piece}
            </span>
          );
        })}
      </>
    );
  }

  return (
    <div className={['teacher-captions', className].filter(Boolean).join(' ')}>
      <p className="teacher-captions__sr" aria-live="polite">{text}</p>
      <p aria-hidden="true" style={{ margin: 0 }}>{body}</p>
    </div>
  );
}
