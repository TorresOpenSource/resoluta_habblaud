// Mensagens pelo escritório para as sessões do Cline: o Cline roda um servidor local ("hub", WebSocket em
// ws://127.0.0.1:<porta>/hub) e o app, a CLI e a extensão falam com ele. O endereço e o token de acesso ficam em
// <pasta do Cline>/data/locks/hub/production.json. Aqui entra como mais um cliente do hub (protocolo v1):
//   1. abre o WebSocket com o token no subprotocolo (`cline-hub-auth.<token>`);
//   2. `client.register` e `stream.subscribe` na sessão;
//   3. `session.send_input` com `delivery: 'queue'` (a mensagem espera o turno atual acabar; com o Cline ocioso, abre
//      um turno novo). O hub só responde quando o turno termina, então a entrega vale já no primeiro evento da
//      sessão (`run.started` ou `session.pending_prompt*`) ou na resposta, o que vier antes; a conexão fica aberta
//      até a resposta (ou HOLD_MS) para não largar o turno no meio.
//
// O token: lido do arquivo a CADA mensagem (nada fica guardado), só enviado a um hub em loopback (nunca a outro
// host), e nunca vai para log, erro, resposta da página nem para o navegador. O texto vai como foi digitado.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Prazo para o hub aceitar a mensagem (conectar, registrar e abrir o turno ou enfileirar). */
export const ACCEPT_TIMEOUT_MS = 20_000;
/** A conexão fica aberta até o turno responder, no máximo isto. */
export const HOLD_MS = 60 * 60_000;
const ERROR_MAX = 300;
const AUTH_PREFIX = 'cline-hub-auth.';
const ACCEPT_EVENTS = new Set(['run.started', 'session.pending_prompt_submitted', 'session.pending_prompts']);

export interface ClineJob {
  /** Id da sessão (AgentInfo.sessionId do agente do Cline). */
  sessionId: string;
  /** Pasta do projeto (só para o registro do cliente no hub). */
  cwd?: string;
  /** O texto como foi digitado. */
  text: string;
}

export type ClineResult = { ok: true } | { ok: false; error: string };
export type ClineRunner = (job: ClineJob) => Promise<ClineResult>;

/** O que se usa de um WebSocket (o global do Node ou um falso, nos testes). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown }) => void): void;
}
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export function hubFile(dir: string): string {
  return join(dir, 'data', 'locks', 'hub', 'production.json');
}

export interface HubEndpoint {
  url: string;
  token: string;
}

/** Endereço e token do hub. Só aceita ws:// em loopback: o token nunca sai da máquina. undefined = sem hub utilizável. */
export function readHubEndpoint(dir: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): HubEndpoint | undefined {
  try {
    const j = JSON.parse(read(hubFile(dir))) as Record<string, unknown>;
    const token = typeof j.authToken === 'string' ? j.authToken.trim() : '';
    const raw = typeof j.url === 'string' ? j.url : '';
    if (!token || !raw) return undefined;
    const u = new URL(raw);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (u.protocol !== 'ws:' || !loopback) return undefined;
    return { url: u.toString(), token };
  } catch {
    return undefined;
  }
}

/** Há um hub do Cline anotado (o arquivo existe e é utilizável)? Não abre conexão. */
export function hubConfigured(dir: string): boolean {
  return readHubEndpoint(dir) !== undefined;
}

function clip(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

let counter = 0;
const rid = (p: string) => `${p}${Date.now().toString(36)}_${(++counter).toString(36)}`;

export interface ClineSenderOptions {
  /** Pasta de dados do Cline (~/.cline). */
  dir: string;
  socket?: SocketFactory;
  acceptTimeoutMs?: number;
  holdMs?: number;
  /** Versão que o Habblaud informa ao registrar o cliente. */
  version?: string;
}

/** Entrega uma mensagem a uma sessão do Cline pelo hub local. Nunca rejeita: falha vira `{ok: false, error}`. */
export function createClineSender(opts: ClineSenderOptions): ClineRunner {
  const make: SocketFactory = opts.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
  const acceptMs = opts.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS;
  const holdMs = opts.holdMs ?? HOLD_MS;

  return (job) =>
    new Promise<ClineResult>((resolve) => {
      const hub = readHubEndpoint(opts.dir);
      if (!hub) return resolve({ ok: false, error: 'o hub do Cline não está no ar (abra o Cline) ou o endereço dele não é local' });

      const clientId = rid('habblaud_');
      const pending = new Map<string, (ok: boolean, error?: string) => void>();
      let settled = false;
      let socket: SocketLike;
      let acceptTimer: ReturnType<typeof setTimeout> | undefined;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;

      const done = (r: ClineResult) => {
        if (settled) return;
        settled = true;
        if (acceptTimer) clearTimeout(acceptTimer);
        resolve(r);
      };
      const closeAll = () => {
        if (acceptTimer) clearTimeout(acceptTimer);
        if (holdTimer) clearTimeout(holdTimer);
        try {
          socket.close();
        } catch {
          // já fechado
        }
      };
      const command = (name: string, payload: unknown, sessionId?: string): Promise<{ ok: boolean; error?: string }> =>
        new Promise((res) => {
          const requestId = rid('hubreq_');
          pending.set(requestId, (ok, error) => res({ ok, error }));
          socket.send(JSON.stringify({ kind: 'command', envelope: { version: 'v1', command: name, requestId, clientId, ...(sessionId ? { sessionId } : {}), timeoutMs: null, payload } }));
        });

      try {
        socket = make(hub.url, [`${AUTH_PREFIX}${hub.token}`]);
      } catch {
        return resolve({ ok: false, error: 'não consegui conectar ao hub do Cline' });
      }
      acceptTimer = setTimeout(() => {
        done({ ok: false, error: 'o hub do Cline não aceitou a mensagem a tempo' });
        closeAll();
      }, acceptMs);

      socket.addEventListener('error', () => {
        done({ ok: false, error: 'não consegui conectar ao hub do Cline' });
        closeAll();
      });
      socket.addEventListener('close', () => {
        done({ ok: false, error: 'o hub do Cline fechou a conexão' });
        if (holdTimer) clearTimeout(holdTimer);
        for (const cb of pending.values()) cb(false, 'o hub do Cline fechou a conexão');
        pending.clear();
      });
      socket.addEventListener('message', (ev) => {
        let frame: { kind?: string; envelope?: Record<string, unknown> };
        try {
          frame = JSON.parse(String(ev.data)) as typeof frame;
        } catch {
          return;
        }
        const env = frame.envelope;
        if (!env) return;
        if (frame.kind === 'reply' && typeof env.requestId === 'string') {
          const cb = pending.get(env.requestId);
          if (!cb) return;
          pending.delete(env.requestId);
          const err = env.error as { message?: unknown } | undefined;
          cb(env.ok === true, typeof err?.message === 'string' ? clip(err.message) : undefined);
        } else if (frame.kind === 'event' && env.sessionId === job.sessionId && typeof env.event === 'string' && ACCEPT_EVENTS.has(env.event)) {
          done({ ok: true });
        }
      });
      socket.addEventListener('open', () => {
        void (async () => {
          try {
            const reg = await command('client.register', {
              clientId,
              clientType: 'habblaud',
              displayName: 'Habblaud',
              transport: 'native',
              actorKind: 'client',
              capabilities: [],
              metadata: { version: opts.version ?? 'habblaud', pid: process.pid },
              workspaceContext: { workspaceRoot: job.cwd, cwd: job.cwd },
            });
            if (!reg.ok) {
              done({ ok: false, error: reg.error ?? 'o hub do Cline recusou o registro' });
              return closeAll();
            }
            socket.send(JSON.stringify({ kind: 'stream.subscribe', clientId, sessionId: job.sessionId }));
            holdTimer = setTimeout(closeAll, holdMs);
            // só responde quando o turno termina; a aceitação já pode ter vindo por evento
            const sent = await command('session.send_input', { prompt: job.text, delivery: 'queue' }, job.sessionId);
            done(sent.ok ? { ok: true } : { ok: false, error: sent.error ?? 'o Cline não aceitou a mensagem' });
          } catch {
            done({ ok: false, error: 'falha ao falar com o hub do Cline' });
          } finally {
            closeAll();
          }
        })();
      });
    });
}
