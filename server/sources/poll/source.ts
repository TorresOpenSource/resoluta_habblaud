// Fonte de agentes "leve" (AgentSource): ferramentas que só mostram presença e status (trabalhando/ocioso), sem
// atividade detalhada, terminal nem histórico. A cada poll chama `scan()`, que devolve as sessões abertas, e
// espelha a diferença no Office (chegou, mudou de status, saiu). Usada pelo Cline e pelo Antigravity.
import type { Provider, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountsService } from '../../accounts/service';
import { errMsg } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';

/** Uma sessão aberta de uma ferramenta, como o leitor dela vê. */
export interface LiveSession {
  sessionId: string;
  cwd: string;
  title?: string;
  working: boolean;
  startedAt: number;
  /** Arquivo da conversa (alimenta o terminal), quando a ferramenta tem um. */
  transcriptPath?: string;
}

export interface PollSourceOptions {
  provider: Exclude<Provider, 'claude'>;
  accounts: AccountsService;
  office: Office;
  /** Pasta de dados da ferramenta (aparece em meta.sources). */
  dir: string;
  account: Pick<DetectedAccount, 'id' | 'short' | 'name' | 'color'>;
  role: string;
  /** Sessões abertas agora. Pode lançar: o erro vai para SourceInfo e a próxima rodada tenta de novo. */
  scan: () => LiveSession[];
  /** Parser do terminal das conversas desta ferramenta; ausente = sem terminal. */
  terminalParser?: () => TerminalParser;
  pollMs?: number;
}

interface Tracked {
  working: boolean;
  title?: string;
  transcriptPath?: string;
}

export class PollSource implements AgentSource {
  readonly provider: Exclude<Provider, 'claude'>;
  private readonly open = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly accountId: string;
  private error: string | undefined;

  constructor(private readonly opts: PollSourceOptions) {
    this.provider = opts.provider;
    const taken = opts.accounts.entries();
    const detected: DetectedAccount = {
      ...opts.account,
      provider: opts.provider,
      configDir: opts.dir,
      // a letra não pode repetir a de uma conta do Claude Code
      short: taken.some((e) => e.detected.short.toUpperCase() === opts.account.short.toUpperCase()) ? '?' : opts.account.short,
    };
    this.accountId = opts.accounts.setProviderAccounts(opts.provider, [{ dir: opts.dir, detected }])[0]?.id ?? opts.account.id;
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll();
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    const info: SourceInfo = { label: this.accountId, provider: this.provider, path: this.opts.dir, sessions: this.open.size, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  transcriptPathOf(agentId: string): string | undefined {
    return this.open.get(agentId)?.transcriptPath;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.open.get(agentId)?.transcriptPath ? this.opts.terminalParser?.() : undefined;
  }

  poll(): void {
    const { office, provider } = this.opts;
    let sessions: LiveSession[];
    try {
      sessions = this.opts.scan();
      this.error = undefined;
    } catch (err) {
      this.error = errMsg(err);
      return;
    }
    const seen = new Set<string>();
    for (const s of sessions) {
      const id = `${this.accountId}:${s.sessionId}`;
      seen.add(id);
      const status = s.working ? 'working' : 'idle';
      let t = this.open.get(id);
      if (!t) {
        office.addMain({ id, provider, account: this.accountId, sessionId: s.sessionId, cwd: s.cwd, role: this.opts.role, startedAt: s.startedAt, status });
        if (!office.has(id)) continue;
        t = { working: s.working };
        this.open.set(id, t);
      } else if (t.working !== s.working) {
        office.setStatus(id, status);
        t.working = s.working;
      }
      t.transcriptPath = s.transcriptPath;
      if (s.title !== t.title) {
        t.title = s.title;
        const info = office.get(id);
        if (info) office.applyTranscript(id, { title: s.title, tasks: info.tasks, stats: info.stats });
      }
    }
    for (const id of [...this.open.keys()]) {
      if (seen.has(id)) continue;
      office.closeMain(id);
      this.open.delete(id);
    }
  }
}
