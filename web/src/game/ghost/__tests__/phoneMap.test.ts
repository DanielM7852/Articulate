import { expect, test } from '../../__tests__/harness';
import { AXES, project } from '../../../vowel/targets';
import { ghostAt } from '../follow';
import { MAP_MARGIN, distanceToPolylines, foldPhone, formantsToMap, mapSymbols, mapToFormants, phoneMapModel, phonePlace } from '../phoneMap';
import { validateGhostModel } from '../validate';
import { GHOST_WORDS } from '../words';
import { PHONE_JUDGED_WORDS, ZONE_PHONES } from '../../../live/phoneJudge';
import phoneMapData from '../phone-map.json';

const VOCAB = `a aɪ aɪ̃ aʊ b d dʒ e eɪ f h i ĩ j k kʰ l l̩ m m̩ n n̩ o oʊ oʊ̃ p pʰ r s sʰ t tʃ u v w x z æ æ̃ ð ŋ ŋ̍ ɑ ɑ̃ ɒ ɔ ɔɪ ə əʊ ə̃ ə̥ ɚ ɛ ɛ̃ ɜ ɝ ɡ ɣ ɦ ɨ ɪ ɹ ɾ ɾ̃ ʃ ʉ ʊ ʊ̃ ʌ ʒ ʔ β θ θʰ`.split(' ');
const P = (s: string) => phonePlace(s)!;

test('phone map: json shape is the shared one', () => {
  expect(phoneMapData.version).toBe(1);
  expect(Object.keys(phoneMapData.axes).join()).toBe('x,y');
});

test('phone map: covers every vocab symbol after folding', () => {
  for (const sym of VOCAB) expect(phonePlace(sym) !== null, sym).toBe(true);
  expect(phonePlace('<unk>')).toBe(null);
  expect(phonePlace('ʘ')).toBe(null);
});

test('phone map: folding rules', () => {
  expect(foldPhone('kʰ')).toBe('k');
  expect(foldPhone('r')).toBe('ɹ');
  expect(foldPhone('g')).toBe('ɡ');
  expect(foldPhone('æ̃')).toBe('æ');
  expect(foldPhone('l̩')).toBe('l');
  expect(foldPhone('ŋ̍')).toBe('ŋ');
  expect(foldPhone('ə̥')).toBe('ə');
  expect(foldPhone('ĩ')).toBe('i');
  expect(foldPhone('oʊ̃')).toBe('oʊ');
});

test('phone map: positions are in [0,1] and labels do not collide', () => {
  const syms = mapSymbols();
  for (const s of syms) {
    expect(P(s).x >= 0 && P(s).x <= 1, s).toBe(true);
    expect(P(s).y >= 0 && P(s).y <= 1, s).toBe(true);
  }
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const d = Math.hypot(P(syms[i]).x - P(syms[j]).x, P(syms[i]).y - P(syms[j]).y);
      expect(d >= 0.03, `${syms[i]} ${syms[j]} ${d.toFixed(3)}`).toBe(true);
    }
  }
});

test('phone map: key articulatory relations', () => {
  expect(P('t').x).toBeLessThan(P('k').x);
  expect(P('p').x).toBeLessThan(P('t').x);
  expect(P('k').x).toBeLessThan(P('h').x);
  expect(P('æ').y).toBeGreaterThan(P('i').y);
  expect(P('i').x).toBeLessThan(P('u').x);
  expect(P('i').x).toBeLessThan(P('ə').x);
  expect(P('ə').x).toBeLessThan(P('u').x);
  expect(P('a').y).toBeGreaterThan(P('e').y);
  // closure order in y: stop < fricative < approximant < vowels
  expect(P('t').y).toBeLessThan(P('s').y);
  expect(P('s').y).toBeLessThan(P('ɹ').y);
  expect(P('ɹ').y).toBeLessThan(P('i').y);
  expect(P('d').y).toBeLessThan(P('z').y);
  expect(P('k').y).toBeLessThan(P('x').y);
  expect(P('x').y).toBeLessThan(P('w').y);
  expect(P('w').y).toBeLessThan(P('ʊ').y);
});

test('phone map: mapToFormants is monotonic, inside the plot, and inverts', () => {
  let prev = mapToFormants(0, 0);
  for (let i = 1; i <= 10; i++) {
    const cur = mapToFormants(i / 10, i / 10);
    expect(cur.f2).toBeLessThan(prev.f2); // x forward -> back: F2 falls
    expect(cur.f1).toBeGreaterThan(prev.f1); // y closed -> open: F1 rises
    prev = cur;
  }
  const a = project(mapToFormants(0, 0));
  const b = project(mapToFormants(1, 1));
  expect(a.x).toBeCloseTo(MAP_MARGIN * 100, 1e-6);
  expect(b.y).toBeCloseTo((1 - MAP_MARGIN) * 100, 1e-6);
  const f = mapToFormants(0.3, 0.7);
  expect(f.f2 < AXES.f2Max && f.f2 > AXES.f2Min && f.f1 > AXES.f1Min && f.f1 < AXES.f1Max).toBe(true);
  const back = formantsToMap(f.f1, f.f2);
  expect(back.x).toBeCloseTo(0.3, 1e-9);
  expect(back.y).toBeCloseTo(0.7, 1e-9);
});

const DURATIONS: Record<string, number> = { track: 445, sheep: 405, rent: 410, brain: 520 };

for (const word of PHONE_JUDGED_WORDS) {
test(`phoneMapModel(${word}): valid, recorded timing, passes through each target place`, () => {
  const model = phoneMapModel(word);
  expect(validateGhostModel(model, GHOST_WORDS[word]).length).toBe(0);
  expect(model.durationMs).toBe(DURATIONS[word]);
  expect(model.factor).toBe(0);
  expect(model.segments.length).toBe(1);
  expect(new Set(model.segments[0].spread).size).toBe(1);
  const timeOf = (zoneId: string) => {
    const m = model.markers.find((x) => x.zoneId === zoneId);
    if (m) return m.t;
    const part = model.parts.find((p) => p.zoneIds.includes(zoneId))!;
    return (part.t0 + part.t1) / 2;
  };
  for (const [zone, sym] of Object.entries(ZONE_PHONES[word])) {
    const g = ghostAt(model, timeOf(zone));
    const got = formantsToMap(g.f1, g.f2);
    expect(got.x, `${sym}.x`).toBeCloseTo(P(sym).x, 0.003);
    expect(got.y, `${sym}.y`).toBeCloseTo(P(sym).y, 0.003);
  }
  // same for everyone: building twice gives the identical, unscaled model
  expect(phoneMapModel(word)).toBe(model);
});
}

test('phoneMapModel: unknown word throws', () => {
  let threw = false;
  try {
    phoneMapModel('nope');
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('distanceToPolylines: segment, endpoint and single-point cases', () => {
  const line = [[{ x: 0, y: 0 }, { x: 1, y: 0 }]];
  expect(distanceToPolylines({ x: 0.5, y: 0.2 }, line)).toBeCloseTo(0.2, 1e-9);
  expect(distanceToPolylines({ x: 1.3, y: 0.4 }, line)).toBeCloseTo(0.5, 1e-9);
  expect(distanceToPolylines({ x: 0.3, y: 0.4 }, [[{ x: 0, y: 0 }]])).toBeCloseTo(0.5, 1e-9);
  expect(distanceToPolylines({ x: 0, y: 0 }, [])).toBe(Infinity);
});
