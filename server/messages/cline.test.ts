// Mensagens ao Cline pelo hub local: o endereço (só loopback), o protocolo (registro, inscrição, send_input) e o
// cuidado com o token. Usa um WebSocket falso: nenhum hub de verdade é tocado.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClineSender, hubConfigured, hubFile, readHubEndpoint, type SocketLike } from './cline';

const TOKEN = 'token-secreto-de-teste';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clineDir(hub: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-cline-'));
  dirs.push(dir);
  if (hub) {
    mkdirSync(join(dir, 'data', 'locks', 'hub'), { recursive: true });
    writeFileSync(hubFile(dir), JSON.stringify(hub));
  }
  return dir;
}
const HUB = { url: 'ws://127.0.0.1:25463/hub', authToken: TOKEN };

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
  /** Responde ao último comando enviado com esse nome. */
  reply(command: string, ok: boolean, error?: string): void {
    const c = [...this.sent].reverse().find((s) => s.envelope?.command === command)!;
    this.frame({ kind: 'reply', envelope: { version: 'v1', requestId: c.envelope!.requestId, ok, ...(error ? { error: { code: 'x', message: error } } : {}) } });
  }
  commands(): string[] {
    return this.sent.filter((s) => s.kind === 'command').map((s) => String(s.envelope!.command));
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function setup(hub: Record<string, unknown> | null = HUB, extra: { acceptTimeoutMs?: number } = {}) {
  const dir = clineDir(hub);
  const sockets: FakeSocket[] = [];
  const send = createClineSender({
    dir,
    ...extra,
    socket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  return { send, sockets, dir };
}

describe('readHubEndpoint', () => {
  it('lê o endereço e o token; só aceita ws:// em loopback', () => {
    expect(readHubEndpoint(clineDir(HUB))).toEqual({ url: 'ws://127.0.0.1:25463/hub', token: TOKEN });
    expect(readHubEndpoint(clineDir({ ...HUB, url: 'ws://localhost:1/hub' }))?.url).toBe('ws://localhost:1/hub');
    expect(readHubEndpoint(clineDir({ ...HUB, url: 'ws://192.168.0.9:25463/hub' }))).toBeUndefined();
    expect(readHubEndpoint(clineDir({ ...HUB, url: 'wss://127.0.0.1:25463/hub' }))).toBeUndefined();
    expect(readHubEndpoint(clineDir({ ...HUB, url: 'ws://evil.example/hub' }))).toBeUndefined();
    expect(readHubEndpoint(clineDir({ url: HUB.url }))).toBeUndefined();
    expect(readHubEndpoint(clineDir(null))).toBeUndefined();
    expect(hubConfigured(clineDir(HUB))).toBe(true);
    expect(hubConfigured(clineDir(null))).toBe(false);
  });
});

describe('createClineSender', () => {
  it('sem hub: falha sem abrir conexão', async () => {
    const t = setup(null);
    const r = await t.send({ sessionId: 's1', text: 'oi' });
    expect(r).toMatchObject({ ok: false });
    expect(t.sockets).toHaveLength(0);
  });

  it('hub fora de loopback: nunca conecta (o token não sai da máquina)', async () => {
    const t = setup({ ...HUB, url: 'ws://10.0.0.5:25463/hub' });
    expect(await t.send({ sessionId: 's1', text: 'oi' })).toMatchObject({ ok: false });
    expect(t.sockets).toHaveLength(0);
  });

  it('registra, inscreve, manda o texto como veio e vale ao primeiro evento da sessão', async () => {
    const t = setup();
    const text = '  -- Faça isso\ncom   espaços  ';
    const p = t.send({ sessionId: 's1', cwd: '/proj', text });
    const s = t.sockets[0];
    expect(s.url).toBe('ws://127.0.0.1:25463/hub');
    expect(s.protocols).toEqual([`cline-hub-auth.${TOKEN}`]);
    s.emit('open');
    await tick();
    expect(s.commands()).toEqual(['client.register']);
    expect(s.sent[0].envelope).toMatchObject({ version: 'v1', payload: { clientType: 'habblaud', transport: 'native', workspaceContext: { cwd: '/proj' } } });
    s.reply('client.register', true);
    await tick();
    expect(s.sent.map((f) => f.kind)).toEqual(['command', 'stream.subscribe', 'command']);
    expect(s.sent[1]).toMatchObject({ sessionId: 's1' });
    const input = s.sent[2].envelope!;
    expect(input).toMatchObject({ command: 'session.send_input', sessionId: 's1', payload: { prompt: text, delivery: 'queue' } });
    // evento de outra sessão não vale; o da sessão vale, e a conexão continua aberta até o turno responder
    s.frame({ kind: 'event', envelope: { event: 'run.started', sessionId: 'outra' } });
    s.frame({ kind: 'event', envelope: { event: 'run.started', sessionId: 's1' } });
    expect(await p).toEqual({ ok: true });
    expect(s.closed).toBe(false);
    s.reply('session.send_input', true);
    await tick();
    expect(s.closed).toBe(true);
  });

  it('a resposta ok do hub também vale (mensagem enfileirada sem turno novo)', async () => {
    const t = setup();
    const p = t.send({ sessionId: 's1', text: 'oi' });
    const s = t.sockets[0];
    s.emit('open');
    await tick();
    s.reply('client.register', true);
    await tick();
    s.reply('session.send_input', true);
    expect(await p).toEqual({ ok: true });
    await tick();
    expect(s.closed).toBe(true);
  });

  it('sessão desconhecida ou recusada: falha com o motivo do hub (sem o token)', async () => {
    const t = setup();
    const p = t.send({ sessionId: 'nao-existe', text: 'oi' });
    const s = t.sockets[0];
    s.emit('open');
    await tick();
    s.reply('client.register', true);
    await tick();
    s.reply('session.send_input', false, 'Unknown session: nao-existe');
    const r = await p;
    expect(r).toEqual({ ok: false, error: 'Unknown session: nao-existe' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('registro recusado, erro de conexão e queda no meio viram falha', async () => {
    const a = setup();
    const pa = a.send({ sessionId: 's', text: 'x' });
    a.sockets[0].emit('open');
    await tick();
    a.sockets[0].reply('client.register', false, 'protocolo não suportado');
    expect(await pa).toEqual({ ok: false, error: 'protocolo não suportado' });

    const b = setup();
    const pb = b.send({ sessionId: 's', text: 'x' });
    b.sockets[0].emit('error');
    expect(await pb).toMatchObject({ ok: false });

    const c = setup();
    const pc = c.send({ sessionId: 's', text: 'x' });
    c.sockets[0].emit('open');
    await tick();
    c.sockets[0].close();
    expect(await pc).toMatchObject({ ok: false });
  });

  it('sem resposta no prazo: falha e fecha a conexão', async () => {
    const t = setup(HUB, { acceptTimeoutMs: 20 });
    const r = await t.send({ sessionId: 's', text: 'x' });
    expect(r).toMatchObject({ ok: false });
    expect(t.sockets[0].closed).toBe(true);
  });
});
