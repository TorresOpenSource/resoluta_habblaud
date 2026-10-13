// Música de fundo: as notas de cada compasso (puras, sem WebAudio).
import { describe, expect, it } from 'vitest';
import { BAR_BEATS, barNotes, midiToFreq } from './music';

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe('música de fundo', () => {
  it('converte nota MIDI em frequência', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(57)).toBeCloseTo(220);
  });

  it('cada compasso tem acorde e baixo, e as notas ficam dentro do compasso', () => {
    for (let bar = 0; bar < 8; bar++) {
      const notes = barNotes(bar, seeded(bar + 1));
      expect(notes.filter((n) => n.voice === 'pad').length).toBe(4);
      expect(notes.some((n) => n.voice === 'bass' && n.at === 0)).toBe(true);
      for (const n of notes) {
        expect(n.at).toBeGreaterThanOrEqual(0);
        expect(n.at).toBeLessThan(BAR_BEATS);
        expect(n.dur).toBeGreaterThan(0);
      }
    }
  });

  it('o laço fecha em quatro compassos e a melodia fica na escala', () => {
    const chord = (bar: number) => barNotes(bar, () => 0.99).filter((n) => n.voice !== 'lead');
    expect(chord(4)).toEqual(chord(0));
    expect(chord(1)).not.toEqual(chord(0));
    expect(chord(-1)).toEqual(chord(3));
    const lead = barNotes(0, () => 0).filter((n) => n.voice === 'lead');
    for (const n of lead) expect([72, 74, 76, 79, 81, 84]).toContain(n.midi);
  });
});
