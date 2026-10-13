// Música do YouTube: o vídeo (ou a playlist) toca num player embutido e escondido, pela IFrame API.
// `parseYouTube` é puro (testável); `YouTubeMusic` cuida do player.

export interface YouTubeSource {
  video?: string;
  list?: string;
}

const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{10,64}$/;

/** Extrai o vídeo e/ou a playlist de um link do YouTube (watch, youtu.be, shorts, embed, music). Null se não for um. */
export function parseYouTube(raw: string): YouTubeSource | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let video: string | undefined;
  if (host === 'youtu.be') video = parts[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') video = url.searchParams.get('v') ?? undefined;
    else if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') video = parts[1];
  } else return null;
  const list = url.searchParams.get('list') ?? undefined;
  const src: YouTubeSource = {};
  if (video && VIDEO_ID.test(video)) src.video = video;
  if (list && LIST_ID.test(list)) src.list = list;
  return src.video || src.list ? src : null;
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  setVolume(v: number): void;
  destroy(): void;
}
interface YTApi {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer;
}

let apiPromise: Promise<YTApi> | null = null;

function loadApi(): Promise<YTApi> {
  const w = window as unknown as { YT?: YTApi & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  apiPromise ??= new Promise<YTApi>((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (w.YT) resolve(w.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube indisponível'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

export class YouTubeMusic {
  private player: YTPlayer | null = null;
  private host: HTMLElement | null = null;
  private key = '';
  private want = false;
  private volume = 50;
  private ready = false;
  private seq = 0;

  /** Toca `src` (troca de faixa se mudou) com o volume 0–100; `false` pausa. */
  set(src: YouTubeSource | null, play: boolean, volume: number): void {
    this.volume = Math.round(Math.max(0, Math.min(100, volume)));
    this.want = play && src !== null;
    const key = src ? `${src.video ?? ''}|${src.list ?? ''}` : '';
    if (src && this.want && key !== this.key) void this.create(src, key);
    else this.apply();
  }

  private apply(): void {
    const p = this.player;
    if (!p || !this.ready) return;
    try {
      p.setVolume(this.volume);
      if (this.want) p.playVideo();
      else p.pauseVideo();
    } catch {
      // player ainda carregando ou removido
    }
  }

  private async create(src: YouTubeSource, key: string): Promise<void> {
    this.dispose();
    this.key = key;
    const id = ++this.seq;
    let api: YTApi;
    try {
      api = await loadApi();
    } catch {
      this.key = '';
      return;
    }
    if (id !== this.seq) return;
    // fora da tela (e não em display:none, que o YouTube trata como player escondido e pode pausar)
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-300px;bottom:0;width:200px;height:200px;overflow:hidden;pointer-events:none;opacity:0.01';
    const inner = document.createElement('div');
    host.append(inner);
    document.body.append(host);
    this.host = host;
    const vars: Record<string, unknown> = { autoplay: 1, controls: 0, loop: 1, playsinline: 1 };
    if (src.list) {
      vars.list = src.list;
      vars.listType = 'playlist';
    } else if (src.video) vars.playlist = src.video; // `loop` num vídeo só vale com `playlist` apontando para ele
    this.player = new api.Player(inner, {
      width: 200,
      height: 200,
      videoId: src.video,
      playerVars: vars,
      events: {
        onReady: () => {
          if (id !== this.seq) return;
          this.ready = true;
          this.apply();
        },
      },
    });
  }

  dispose(): void {
    this.seq++;
    this.ready = false;
    this.key = '';
    try {
      this.player?.destroy();
    } catch {
      // já removido
    }
    this.player = null;
    this.host?.remove();
    this.host = null;
  }
}
