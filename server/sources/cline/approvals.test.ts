// Aprovar pelo escritório os pedidos do Cline: conexão ao hub só com página aberta, cartão por pedido, decisão de volta
// ao hub (approval.respond) e pedido resolvido por fora. WebSocket falso: nenhum hub de verdade é tocado.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { hubFile, type SocketLike } from '../../messages/cline';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { PermissionRegistry } from '../../permissions/registry';
import { ClineApprovals } from './approvals';

setQuiet(true);

const TOKEN = 'token-secreto-de-teste';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Listener = (ev: { data?: unknown }) => void;
class FakeSocket implements SocketLike {
  sent: Array<{ kind: string; envelope?: Record<string, unknown>; [k: string]: unknown }> = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  addEventListener(type: string, l: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  frame(f: unknown): void {
    this.emit('message', JSON.stringify(f));
  }
  reply(command: string, ok = true, error?: string): void {
    const c = [...this.sent].reverse().find((s) => s.envelope?.command === command)!;
    this.frame({ kind: 'reply', envelope: { version: 'v1', requestId: c.envelope!.requestId, ok, ...(error ? { error: { code: 'x', message: error } } : {}) } });
  }
  commands(): string[] {
    return this.sent.filter((s) => s.kind === 'command').map((s) => String(s.envelope!.command));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { hub?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-appr-'));
  dirs.push(dir);
  if (opts.hub !== false) {
    mkdirSync(join(dir, 'data', 'locks', 'hub'), { recursive: true });
    writeFileSync(hubFile(dir), JSON.stringify({ url: 'ws://127.0.0.1:25463/hub', authToken: TOKEN }));
  }
  let now = 1_000_000;
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: () => now,
  });
  office.addMain({ id: '.cline:c1', provider: 'cline', account: '.cline', sessionId: 'cline-sess', cwd: '/p/app', role: 'Agente principal (Cline)', startedAt: 0, status: 'working' });
  permissions = new PermissionRegistry({ office, viewers: () => 1, now: () => now });
  let active = true;
  const sockets: FakeSocket[] = [];
  let retry = 0;
  const approvals = new ClineApprovals({
    dir,
    office,
    permissions,
    active: () => active,
    now: () => now + retry,
    retryMs: 5_000,
    socket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  return {
    office,
    permissions,
    approvals,
    sockets,
    setActive: (v: boolean) => (active = v),
    pass: (ms: number) => (retry += ms),
    snap: () => office.commit().snapshot.agents.find((a) => a.id === '.cline:c1')!,
  };
}

async function connected(t: ReturnType<typeof setup>): Promise<FakeSocket> {
  t.approvals.check();
  const s = t.sockets[t.sockets.length - 1];
  s.emit('open');
  await tick();
  s.reply('client.register');
  await tick();
  return s;
}

const REQUESTED = (over: Record<string, unknown> = {}) => ({
  kind: 'event',
  envelope: { version: 'v1', event: 'approval.requested', sessionId: 'cline-sess', payload: { approvalId: 'appr_1', sessionId: 'cline-sess', toolName: 'run_commands', inputJson: JSON.stringify({ commands: ['npm test'] }), ...over } },
});

describe('ClineApprovals: conexão', () => {
  it('só conecta com página aberta e desconecta quando a última fecha; token só no subprotocolo', async () => {
    const t = setup();
    t.setActive(false);
    t.approvals.check();
    expect(t.sockets).toHaveLength(0);

    t.setActive(true);
    const s = await connected(t);
    expect(s.url).toBe('ws://127.0.0.1:25463/hub');
    expect(s.protocols).toEqual([`cline-hub-auth.${TOKEN}`]);
    // registra sem declarar `approval.respond` e assina todas as sessões
    expect(s.sent[0].envelope).toMatchObject({ command: 'client.register', payload: { clientType: 'habblaud', capabilities: [] } });
    expect(s.sent[1]).toMatchObject({ kind: 'stream.subscribe' });
    expect(s.sent[1]).not.toHaveProperty('sessionId');
    expect(t.approvals.connected).toBe(true);

    t.setActive(false);
    t.approvals.check();
    expect(s.closed).toBe(true);
    expect(t.approvals.connected).toBe(false);
  });

  it('sem hub (Cline fechado): não conecta e tenta de novo depois', () => {
    const t = setup({ hub: false });
    t.approvals.check();
    expect(t.sockets).toHaveLength(0);
  });

  it('queda: espera antes de tentar de novo', async () => {
    const t = setup();
    const s = await connected(t);
    s.close();
    t.approvals.check();
    expect(t.sockets).toHaveLength(1);
    t.pass(5_000);
    t.approvals.check();
    expect(t.sockets).toHaveLength(2);
  });
});

describe('ClineApprovals: pedidos', () => {
  it('o pedido vira cartão (agente esperando) e a decisão volta ao hub', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED());
    const a = t.snap();
    expect(a.status).toBe('waiting');
    expect(a.permission).toMatchObject({ provider: 'cline', tool: 'run_commands', title: 'run_commands(npm test)', text: 'Rodar comando' });
    expect(a.waitingFor).toBe('aprovar uma ferramenta');
    expect(a.permission).not.toHaveProperty('input');

    // o detalhe completo (só pelo registro) traz os argumentos
    expect(t.permissions.detail(a.permission!.id)?.input).toContain('npm test');
    expect(t.permissions.decide(a.permission!.id, { behavior: 'allow' })).toBe('ok');
    expect(s.commands()).toEqual(['client.register', 'approval.respond']);
    expect(s.sent.at(-1)!.envelope).toMatchObject({ payload: { approvalId: 'appr_1', approved: true } });
    expect(t.snap().permission).toBeUndefined();
  });

  it('recusar leva o motivo; interromper e "sempre permitir" não existem no Cline', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED());
    const id = t.snap().permission!.id;
    expect(t.permissions.decide(id, { behavior: 'deny', interrupt: true })).toBe('unsupported');
    expect(t.permissions.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(t.permissions.decide(id, { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    expect(s.sent.at(-1)!.envelope).toMatchObject({ command: 'approval.respond', payload: { approvalId: 'appr_1', approved: false, reason: 'use pnpm' } });
  });

  it('o mesmo pedido reenviado (reconexão) não duplica', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED());
    s.frame(REQUESTED());
    expect(t.permissions.size).toBe(1);
  });

  it('resolvido por fora (app do Cline): o cartão some sem responder ao hub', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED());
    expect(t.snap().permission).toBeDefined();
    s.frame({ kind: 'event', envelope: { event: 'approval.resolved', sessionId: 'cline-sess', payload: { approvalId: 'appr_1', approved: true } } });
    expect(t.snap().permission).toBeUndefined();
    expect(s.commands()).toEqual(['client.register']);
  });

  it('"deixar no terminal" devolve o pedido sem responder ao hub', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED());
    expect(t.permissions.decide(t.snap().permission!.id, { behavior: 'terminal' })).toBe('ok');
    expect(s.commands()).toEqual(['client.register']);
  });

  it('pedido de sessão que não está no escritório ou malformado é ignorado', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED({ sessionId: 'outra' }));
    s.frame(REQUESTED({ toolName: '' }));
    s.frame(REQUESTED({ approvalId: '' }));
    s.emit('message', 'não é json');
    expect(t.permissions.size).toBe(0);
  });

  it('argumentos ilegíveis: o cartão mostra só o nome da ferramenta', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED({ inputJson: '{quebrado' }));
    expect(t.snap().permission).toMatchObject({ tool: 'run_commands', title: 'run_commands' });
  });

  it('segredos nos argumentos saem mascarados', async () => {
    const t = setup();
    const s = await connected(t);
    s.frame(REQUESTED({ inputJson: JSON.stringify({ commands: ['curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"'] }) }));
    const id = t.snap().permission!.id;
    expect(JSON.stringify(t.permissions.detail(id))).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
