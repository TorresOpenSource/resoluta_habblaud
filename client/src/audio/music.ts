// Música de fundo (sintetizada, sem arquivos de áudio): um laço calmo de acordes, baixo e notas soltas
// que toca enquanto há trabalho em execução. `barNotes` é puro (testável); `MusicPlayer` agenda os
// compassos no AudioContext, com entrada e saída suaves.

export const BPM = 70;
export const BEAT_S = 60 / BPM;
export const BAR_BEATS = 4;

export type MusicVoice = 'pad' | 'bass' | 'lead';

export interface MusicNote {
  voice: MusicVoice;
  /** Nota MIDI (69 = lá 440 Hz). */
  midi: number;
  /** Início, em tempos desde o começo do compasso. */
  at: number;
  /** Duração, em tempos. */
  dur: number;
}

/** Cmaj7 · Am7 · Dm7 · G7: um compasso cada, o laço fecha de volta no primeiro. */
const CHORDS: readonly { bass: number; pad: readonly number[] }[] = [
  { bass: 48, pad: [55, 59, 62, 64] },
  { bass: 45, pad: [55, 57, 60, 64] },
  { bass: 50, pad: [53, 57, 60, 64] },
  { bass: 43, pad: [53, 55, 59, 62] },
];

/** Pentatônica de dó maior: qualquer nota combina com qualquer um dos acordes. */
const LEAD_SCALE: readonly number[] = [72, 74, 76, 79, 81, 84];

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Notas do compasso `bar` (o acorde vem do número do compasso; as notas soltas, de `rng`). */
export function barNotes(bar: number, rng: () => number): MusicNote[] {
  const chord = CHORDS[((bar % CHORDS.length) + CHORDS.length) % CHORDS.length];
  const notes: MusicNote[] = chord.pad.map((midi) => ({ voice: 'pad', midi, at: 0, dur: BAR_BEATS + 0.4 }));
  notes.push({ voice: 'bass', midi: chord.bass, at: 0, dur: 1.6 }, { voice: 'bass', midi: chord.bass, at: 2, dur: 1.6 });
  if (rng() < 0.35) notes.push({ voice: 'bass', midi: chord.bass + 7, at: 3.5, dur: 0.5 });
  let prev = Math.floor(rng() * LEAD_SCALE.length);
  for (let i = 1; i < BAR_BEATS * 2; i++) {
    if (rng() < 0.62) continue;
    // anda por graus próximos, como uma melodia, em vez de pular a esmo
    prev = Math.max(0, Math.min(LEAD_SCALE.length - 1, prev + Math.floor(rng() * 3) - 1));
    notes.push({ voice: 'lead', midi: LEAD_SCALE[prev], at: i * 0.5, dur: 1 });
  }
  return notes;
}

/** Quanto adiantar o agendamento (s): o próximo compasso entra na fila quando faltar menos que isto. */
const LOOKAHEAD_S = 1.2;
const TICK_MS = 250;
/** Constantes de tempo (s) da entrada e da saída suaves. */
const FADE_IN_S = 1.2;
const FADE_OUT_S = 0.7;

export class MusicPlayer {
  private readonly bus: GainNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBarAt = 0;
  private bar = 0;

  constructor(
    private readonly ac: AudioContext,
    dest: AudioNode,
    private readonly rng: () => number = Math.random,
  ) {
    // suaviza os agudos: música de fundo, não de destaque
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    this.bus = ac.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(lp).connect(dest);
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Começa (com entrada suave) ou, se já toca, só ajusta o volume. */
  start(level: number): void {
    const now = this.ac.currentTime;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(level, now, FADE_IN_S / 3);
    if (this.timer) return;
    this.nextBarAt = Math.max(this.nextBarAt, now + 0.1);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Para de agendar compassos e some com a música em seguida. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ac.currentTime;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(0, now, FADE_OUT_S / 3);
  }

  private tick(): void {
    try {
      while (this.nextBarAt < this.ac.currentTime + LOOKAHEAD_S) {
        for (const n of barNotes(this.bar, this.rng)) this.voice(n, this.nextBarAt + n.at * BEAT_S);
        this.bar++;
        this.nextBarAt += BAR_BEATS * BEAT_S;
      }
    } catch {
      this.stop();
    }
  }

  private voice(n: MusicNote, t: number): void {
    const { peak, attack, type } = VOICES[n.voice];
    const dur = n.dur * BEAT_S;
    const o = this.ac.createOscillator();
    const g = this.ac.createGain();
    o.type = type;
    o.frequency.value = midiToFreq(n.midi);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    // pad sustenta e solta; baixo e notas soltas caem como um toque
    if (n.voice === 'pad') g.gain.setValueAtTime(peak, t + Math.max(attack, dur - 0.9));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

const VOICES: Readonly<Record<MusicVoice, { peak: number; attack: number; type: OscillatorType }>> = {
  pad: { peak: 0.05, attack: 0.5, type: 'triangle' },
  bass: { peak: 0.16, attack: 0.03, type: 'sine' },
  lead: { peak: 0.06, attack: 0.012, type: 'sine' },
};
