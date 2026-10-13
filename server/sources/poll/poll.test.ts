// Fontes leves (Cline e Antigravity): leitores dos bancos SQLite e a PollSource que espelha as sessões no Office.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { ANTIGRAVITY_OPEN_MS, scanAntigravity, workspacePath } from '../antigravity/scan';
import { CLINE_WORKING_MS, scanCline } from '../cline/scan';
import { parseDbTime } from '../sqlite';
import { PollSource, type LiveSession } from './source';

setQuiet(true);

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-poll-'));
  dirs.push(d);
  return d;
}
const NOW = Date.parse('2026-10-12T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sqlValue = (v: unknown) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function insert(db: { exec(sql: string): void }, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.exec(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => sqlValue(row[c])).join(',')})`);
}

describe('parseDbTime', () => {
  it('lê ISO e o formato do Antigravity (espaço e 7 casas)', () => {
    expect(parseDbTime('2026-10-12T20:00:00.000Z')).toBe(NOW);
    expect(parseDbTime('2026-10-12 20:00:00.8657423+00:00')).toBe(NOW + 865);
    expect(parseDbTime('2026-10-12 20:00:00')).toBe(NOW);
    expect(parseDbTime('')).toBeUndefined();
    expect(parseDbTime('lixo')).toBeUndefined();
  });
});

describe('scanCline', () => {
  function clineDir(rows: Array<Record<string, unknown>>): string {
    const dir = tmp();
    mkdirSync(join(dir, 'data', 'db'), { recursive: true });
    const db = new DatabaseSync(join(dir, 'data', 'db', 'sessions.db'));
    db.exec('CREATE TABLE sessions (session_id TEXT, pid INTEGER, started_at TEXT, ended_at TEXT, status TEXT, cwd TEXT, workspace_root TEXT, is_subagent INTEGER, messages_path TEXT, updated_at TEXT)');
    for (const r of rows) {
      insert(db, 'sessions', { ended_at: null, status: 'running', cwd: '/p', workspace_root: '/p', is_subagent: 0, messages_path: null, updated_at: iso(NOW), started_at: iso(NOW - 60_000), pid: 1, ...r });
    }
    db.close();
    return dir;
  }

  it('só sessões abertas, vivas e que não são subagentes', () => {
    const dir = clineDir([
      { session_id: 'a' },
      { session_id: 'morta', pid: 2 },
      { session_id: 'fim', status: 'completed' },
      { session_id: 'encerrada', ended_at: iso(NOW) },
      { session_id: 'sub', is_subagent: 1 },
    ]);
    const live = scanCline(dir, NOW, (pid) => pid === 1);
    expect(live.map((s) => s.sessionId)).toEqual(['a']);
    expect(live[0]).toMatchObject({ cwd: '/p', working: true, startedAt: NOW - 60_000 });
  });

  it('trabalhando = atividade recente (banco ou arquivo de mensagens)', () => {
    const dir = clineDir([{ session_id: 'a', updated_at: iso(NOW - CLINE_WORKING_MS - 1) }]);
    expect(scanCline(dir, NOW, () => true)[0].working).toBe(false);
    const msgs = join(tmp(), 'a.messages.json');
    writeFileSync(msgs, '{}');
    utimesSync(msgs, (NOW - 1_000) / 1000, (NOW - 1_000) / 1000);
    const dir2 = clineDir([{ session_id: 'a', updated_at: iso(NOW - CLINE_WORKING_MS - 1), messages_path: msgs }]);
    expect(scanCline(dir2, NOW, () => true)[0].working).toBe(true);
  });
});

describe('scanAntigravity', () => {
  function agyDir(rows: Array<Record<string, unknown>>): string {
    const dir = tmp();
    const db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, last_modified_time TEXT, workspace_uris TEXT, status TEXT, killed INTEGER, last_user_input_time TEXT, parent_conversation_id TEXT NOT NULL DEFAULT '')");
    for (const r of rows) {
      insert(db, 'conversation_summaries', { title: 'T', last_modified_time: iso(NOW), workspace_uris: '["file:///h%3A/meu%20projeto"]', status: 'CASCADE_RUN_STATUS_IDLE', killed: 0, last_user_input_time: iso(NOW - 5_000), parent_conversation_id: '', ...r });
    }
    db.close();
    return dir;
  }

  it('lê projeto, título e status; ignora subagentes, mortas e antigas', () => {
    const dir = agyDir([
      { conversation_id: 'ocioso' },
      { conversation_id: 'rodando', status: 'CASCADE_RUN_STATUS_RUNNING', last_modified_time: iso(NOW - 3 * ANTIGRAVITY_OPEN_MS) },
      { conversation_id: 'velha', last_modified_time: iso(NOW - ANTIGRAVITY_OPEN_MS - 1) },
      { conversation_id: 'sub', parent_conversation_id: 'ocioso' },
      { conversation_id: 'morta', killed: 1 },
      { conversation_id: 'semprojeto', workspace_uris: '[]' },
    ]);
    const live = scanAntigravity(dir, NOW);
    expect(live.map((s) => [s.sessionId, s.working]).sort()).toEqual([
      ['ocioso', false],
      ['rodando', true],
    ]);
    expect(live.find((s) => s.sessionId === 'ocioso')).toMatchObject({ cwd: 'h:/meu projeto', title: 'T' });
  });

  it('converte URIs de pasta', () => {
    expect(workspacePath('file:///h%3A/resoluta_pront')).toBe('h:/resoluta_pront');
    expect(workspacePath('file:///home/u/p')).toBe('/home/u/p');
    expect(workspacePath('https://x')).toBeUndefined();
  });
});

describe('PollSource', () => {
  function setup() {
    const clock = NOW;
    const late: { office?: Office } = {};
    const accounts = new AccountsService({ dirs: [], home: tmp(), env: {}, now: () => clock, onChange: () => late.office?.markDirty() });
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: clock,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: (id) => accounts.find(id)?.detected.name,
      now: () => clock,
    });
    late.office = office;
    let sessions: LiveSession[] = [];
    let fail = false;
    const source = new PollSource({
      provider: 'cline',
      accounts,
      office,
      dir: '/x/.cline',
      account: { id: '.cline', short: 'L', name: 'Cline', color: '#e8c44a' },
      role: 'Agente principal (Cline)',
      scan: () => {
        if (fail) throw new Error('banco travado');
        return sessions;
      },
    });
    return {
      office,
      source,
      accounts,
      set: (s: LiveSession[]) => (sessions = s),
      breakScan: (v: boolean) => (fail = v),
    };
  }
  const live = (p: Partial<LiveSession> = {}): LiveSession => ({ sessionId: 's1', cwd: '/proj/app', working: false, startedAt: NOW, ...p });

  it('registra a conta e espelha chegada, status, título e saída', () => {
    const t = setup();
    expect(t.accounts.entriesOf('cline').map((e) => [e.id, e.detected.name, e.detected.provider])).toEqual([['.cline', 'Cline', 'cline']]);
    t.set([live({ title: 'Corrigir bug' })]);
    t.source.poll();
    const a = t.office.get('.cline:s1')!;
    expect(a).toMatchObject({ provider: 'cline', status: 'idle', account: '.cline', title: 'Corrigir bug', role: 'Agente principal (Cline)' });
    expect(t.source.sources()).toEqual([{ label: '.cline', provider: 'cline', path: '/x/.cline', sessions: 1, ok: true }]);

    t.set([live({ working: true })]);
    t.source.poll();
    expect(t.office.get('.cline:s1')!.status).toBe('working');

    t.set([]);
    t.source.poll();
    expect(t.office.get('.cline:s1')!.status).toBe('offline');
    expect(t.source.sources()[0].sessions).toBe(0);
  });

  it('erro do leitor vai para SourceInfo e não derruba as sessões', () => {
    const t = setup();
    t.set([live()]);
    t.source.poll();
    t.breakScan(true);
    t.source.poll();
    expect(t.source.sources()[0]).toMatchObject({ ok: false, error: 'banco travado', sessions: 1 });
    expect(t.office.get('.cline:s1')!.status).toBe('idle');
    t.breakScan(false);
    t.source.poll();
    expect(t.source.sources()[0].ok).toBe(true);
  });

  it('sem arquivo de conversa não há terminal; com ele, o caminho e o parser', () => {
    const t = setup();
    t.set([live()]);
    t.source.poll();
    expect(t.source.transcriptPathOf('.cline:s1')).toBeUndefined();
    expect(t.source.terminalParser('.cline:s1')).toBeUndefined();
    t.set([live({ transcriptPath: '/x/s1.messages.json' })]);
    t.source.poll();
    expect(t.source.transcriptPathOf('.cline:s1')).toBe('/x/s1.messages.json');
    expect(t.source.transcriptPathOf('outro')).toBeUndefined();
  });
});
