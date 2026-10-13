// Aprovar pelo escritório os pedidos de ferramenta do Cline. O hub local do Cline (o mesmo de messages/cline.ts)
// publica o evento `approval.requested` (approvalId, sessionId, toolName, inputJson) e deixa o pedido pendente até
// alguém mandar `approval.respond {approvalId, approved, reason?}`; a primeira resposta vale (a do app do Cline ou a
// do Habblaud) e o hub avisa com `approval.resolved`. Aqui o Habblaud é mais um cliente do hub:
// - só fica conectado enquanto há uma página local do Habblaud aberta (`active()`); fechando a última, desconecta, e o
//   Cline volta a pedir só no app dele. Ao conectar, o hub reenvia os pedidos que estavam pendentes;
// - cada pedido de uma sessão que está no escritório vira um cartão "Pede permissão" (PermissionRegistry.registerNative)
//   e a decisão do cartão volta ao hub por `approval.respond`; um pedido resolvido por fora some do cartão;
// - não declara a capacidade `approval.respond` no registro: o hub continua tratando o app do Cline como quem decide.
// Token: lido do arquivo do hub A CADA conexão (messages/cline.ts, readHubEndpoint: só loopback), nunca guardado, nunca
// em log nem em erro.
import type { AgentInfo } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { readHubEndpoint, type SocketFactory, type SocketLike } from '../../messages/cline';
import type { PermissionRegistry } from '../../permissions/registry';
import { tr } from '../../../shared/i18n';

const AUTH_PREFIX = 'cline-hub-auth.';
/** Quantas vezes por segundo se confere se há página aberta e se a conexão precisa mudar. */
export const CHECK_MS = 2_000;
/** Espera mínima entre tentativas de conectar depois de uma falha. */
export const RETRY_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;

export interface ClineApprovalsOptions {
  /** Pasta de dados do Cline (~/.cline). */
  dir: string;
  office: { list(): AgentInfo[] };
  permissions: Pick<PermissionRegistry, 'registerNative' | 'releaseExternal'>;
  /** Há uma página local do Habblaud aberta? (Hub.localSize > 0) */
  active: () => boolean;
  socket?: SocketFactory;
  now?: () => number;
  checkMs?: number;
  retryMs?: number;
  version?: string;
}

interface Conn {
  socket: SocketLike;
  clientId: string;
  registered: boolean;
  pending: Map<string, (ok: boolean, error?: string) => void>;
}

let counter = 0;
const rid = (p: string) => `${p}${Date.now().toString(36)}_${(++counter).toString(36)}`;

export class ClineApprovals {
  private conn: Conn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryAt = 0;
  private readonly now: () => number;
  private readonly make: SocketFactory;

  constructor(private readonly opts: ClineApprovalsOptions) {
    this.now = opts.now ?? Date.now;
    this.make = opts.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.opts.checkMs ?? CHECK_MS);
    this.timer.unref?.();
    this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disconnect();
  }

  /** Conectado e registrado no hub? */
  get connected(): boolean {
    return !!this.conn?.registered;
  }

  /** Liga ou desliga a conexão conforme haja página aberta. */
  check(): void {
    const wanted = this.opts.active();
    if (!wanted) return this.disconnect();
    if (this.conn || this.now() < this.retryAt) return;
    this.connect();
  }

  private disconnect(): void {
    const c = this.conn;
    if (!c) return;
    this.conn = null;
    try {
      c.socket.close();
    } catch {
      // já fechado
    }
  }

  private fail(): void {
    this.retryAt = this.now() + (this.opts.retryMs ?? RETRY_MS);
    this.disconnect();
  }

  private command(c: Conn, name: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const requestId = rid('hubreq_');
      const timer = setTimeout(() => {
        c.pending.delete(requestId);
        resolve({ ok: false, error: tr('sem resposta do hub do Cline') });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      c.pending.set(requestId, (ok, error) => {
        clearTimeout(timer);
        resolve({ ok, error });
      });
      try {
        c.socket.send(JSON.stringify({ kind: 'command', envelope: { version: 'v1', command: name, requestId, clientId: c.clientId, timeoutMs: COMMAND_TIMEOUT_MS, payload } }));
      } catch {
        c.pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, error: tr('conexão com o hub do Cline fechada') });
      }
    });
  }

  private connect(): void {
    const hub = readHubEndpoint(this.opts.dir);
    if (!hub) {
      this.retryAt = this.now() + (this.opts.retryMs ?? RETRY_MS);
      return;
    }
    let socket: SocketLike;
    try {
      socket = this.make(hub.url, [`${AUTH_PREFIX}${hub.token}`]);
    } catch {
      return this.fail();
    }
    const c: Conn = { socket, clientId: rid('habblaud_'), registered: false, pending: new Map() };
    this.conn = c;
    socket.addEventListener('error', () => {
      if (this.conn === c) this.fail();
    });
    socket.addEventListener('close', () => {
      for (const cb of c.pending.values()) cb(false, tr('conexão com o hub do Cline fechada'));
      c.pending.clear();
      if (this.conn === c) {
        this.conn = null;
        this.retryAt = this.now() + (this.opts.retryMs ?? RETRY_MS);
      }
    });
    socket.addEventListener('message', (ev) => this.onFrame(c, ev.data));
    socket.addEventListener('open', () => {
      void (async () => {
        const reg = await this.command(c, 'client.register', {
          clientId: c.clientId,
          clientType: 'habblaud',
          displayName: 'Habblaud',
          transport: 'native',
          actorKind: 'client',
          capabilities: [],
          metadata: { version: this.opts.version ?? 'habblaud', pid: process.pid },
          workspaceContext: {},
        });
        if (this.conn !== c) return;
        if (!reg.ok) {
          log.warnOnce(`cline-approvals-register:${reg.error}`, tr('Aprovações do Cline: o hub recusou o registro ({0}).', [reg.error ?? tr('sem motivo')]));
          return this.fail();
        }
        c.registered = true;
        // sem sessão = todas; o hub reenvia os pedidos pendentes ao assinar
        socket.send(JSON.stringify({ kind: 'stream.subscribe', clientId: c.clientId }));
      })().catch((err) => {
        log.warnOnce(`cline-approvals:${errMsg(err)}`, tr('Aprovações do Cline: {0}', [errMsg(err)]));
        if (this.conn === c) this.fail();
      });
    });
  }

  private onFrame(c: Conn, data: unknown): void {
    let frame: { kind?: string; envelope?: Record<string, unknown> };
    try {
      frame = JSON.parse(String(data)) as typeof frame;
    } catch {
      return;
    }
    const env = frame.envelope;
    if (!env) return;
    if (frame.kind === 'reply' && typeof env.requestId === 'string') {
      const cb = c.pending.get(env.requestId);
      if (!cb) return;
      c.pending.delete(env.requestId);
      const err = env.error as { message?: unknown } | undefined;
      cb(env.ok === true, typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined);
      return;
    }
    if (frame.kind !== 'event') return;
    const payload = (env.payload && typeof env.payload === 'object' ? env.payload : {}) as Record<string, unknown>;
    if (env.event === 'approval.requested') this.onRequested(payload);
    else if (env.event === 'approval.resolved' && typeof payload.approvalId === 'string') this.opts.permissions.releaseExternal(payload.approvalId);
  }

  private onRequested(p: Record<string, unknown>): void {
    const approvalId = typeof p.approvalId === 'string' ? p.approvalId : '';
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
    const tool = typeof p.toolName === 'string' ? p.toolName : '';
    if (!approvalId || !sessionId || !tool) return;
    const agent = this.opts.office.list().find((a) => a.provider === 'cline' && a.kind === 'main' && a.sessionId === sessionId && a.status !== 'offline' && a.status !== 'done');
    if (!agent) return;
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof p.inputJson === 'string' ? JSON.parse(p.inputJson) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      // argumentos ilegíveis: o cartão mostra só o nome da ferramenta
    }
    this.opts.permissions.registerNative({ provider: 'cline', agentId: agent.id, externalId: approvalId, tool, input }, (outcome) => {
      // só uma decisão do cartão volta ao hub; "deixar no terminal", expirar ou sair não respondem (o Cline decide)
      if (outcome.status !== 'decided' || outcome.behavior === 'answer') return;
      // a conexão de agora (o pedido pode ter vindo numa anterior e voltado no reenvio ao reconectar)
      const live = this.conn?.registered ? this.conn : undefined;
      if (!live) return log.warnOnce('cline-approval-offline', tr('Aprovações do Cline: sem conexão com o hub para entregar a decisão (responda no app do Cline).'));
      void this.command(live, 'approval.respond', { approvalId, approved: outcome.behavior === 'allow', ...(outcome.message ? { reason: outcome.message } : {}) }).then((r) => {
        if (!r.ok) log.warnOnce(`cline-approval-respond:${r.error}`, tr('Aprovações do Cline: o hub não aceitou a resposta ({0}).', [r.error ?? tr('sem motivo')]));
      });
    });
  }
}
