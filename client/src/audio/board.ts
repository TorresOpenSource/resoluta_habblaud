// Mesa de som: um AudioContext para tudo (criado só depois de um gesto do usuário, como pede a
// política de autoplay), volume mestre com limitador e o agendador que decide o que toca.
import { MusicPlayer } from './music';
import { parseYouTube, YouTubeMusic } from './youtube';
import { DEFAULT_SOUND_SETTINGS, masterGain, SoundScheduler, type SoundKind, type SoundSettings } from './scheduler';
import { makeNoise, playVoice } from './synth';

/** A música fica mais baixa que os avisos: é pano de fundo. */
const MUSIC_LEVEL = 0.4;
/** Depois que o último trabalho termina, a música espera isto (ms) antes de sumir (evita liga-e-desliga entre ferramentas). */
export const MUSIC_GRACE_MS = 6_000;

export class SoundBoard {
  readonly scheduler = new SoundScheduler();
  private ac: AudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private settings: SoundSettings = DEFAULT_SOUND_SETTINGS;
  private music: MusicPlayer | null = null;
  private readonly youtube = new YouTubeMusic();
  private working = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  configure(enabled: boolean, settings: SoundSettings): void {
    this.enabled = enabled;
    this.settings = settings;
    this.scheduler.configure(enabled, settings);
    this.applyMusic();
  }

  /** Há trabalho em execução? A música liga na hora e só some depois de uma pequena folga. */
  setWorking(working: boolean): void {
    if (working) {
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this.working = true;
    } else if (this.working && !this.stopTimer) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        this.working = false;
        this.applyMusic();
      }, MUSIC_GRACE_MS);
    }
    this.applyMusic();
  }

  /** Reavalia a música (aba que ficou visível ou oculta, áudio liberado...). */
  refresh(): void {
    this.applyMusic();
  }

  private applyMusic(): void {
    const ac = this.ac;
    const s = this.settings;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const wanted = this.enabled && s.music && s.volume > 0 && this.working && !hidden;
    const yt = parseYouTube(s.musicUrl);
    // com um link do YouTube válido, a música é a dele; senão, a sintetizada
    this.youtube.set(yt, wanted && yt !== null, s.volume * 100 * MUSIC_LEVEL * 2);
    const synth = wanted && yt === null && ac !== null && this.out !== null && ac.state === 'running';
    try {
      if (synth && ac && this.out) {
        this.music ??= new MusicPlayer(ac, this.out);
        this.music.start(masterGain(s.volume) * MUSIC_LEVEL);
      } else {
        this.music?.stop();
      }
    } catch {
      this.music = null;
    }
  }

  /**
   * Precisa ser chamado a partir de um gesto do usuário (clique/tecla) para o navegador liberar o
   * áudio. Resolve quando o áudio está pronto (ou não pôde ser liberado).
   */
  unlock(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    try {
      if (!this.ac) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return Promise.resolve();
        const ac = new Ctor();
        // limitador suave: vários sons juntos nunca estouram
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 12;
        comp.ratio.value = 6;
        comp.connect(ac.destination);
        this.ac = ac;
        this.out = comp;
        this.noise = makeNoise(ac);
      }
      if (this.ac.state === 'suspended') return this.ac.resume().catch(() => undefined).then(() => this.applyMusic());
      this.applyMusic();
    } catch {
      this.ac = null;
      this.out = null;
    }
    return Promise.resolve();
  }

  /** Toca `kind` se a preferência e os limites deixarem. Devolve se tocou. */
  play(kind: SoundKind, opts: { gain?: number; pan?: number; count?: number } = {}): boolean {
    const ac = this.ac;
    if (!ac || !this.out || ac.state !== 'running') return false;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const gain = this.scheduler.decide(kind, performance.now(), { hidden, gain: opts.gain });
    if (gain === null) return false;
    try {
      playVoice(ac, this.out, kind, ac.currentTime + 0.01, { gain, pan: opts.pan, count: opts.count, rng: Math.random, noise: this.noise });
      return true;
    } catch {
      return false;
    }
  }
}
