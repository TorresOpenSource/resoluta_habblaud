// Conversas do Antigravity (Google): ~/.gemini/antigravity/conversation_summaries.db (SQLite, só leitura), que o
// app mantém com título, pasta do projeto, status e última modificação de cada conversa. Não existe um registro de
// sessões abertas: uma conversa conta como aberta se está rodando ou foi mexida há menos de ANTIGRAVITY_OPEN_MS.
// Os subagentes (conversas com pai) e as encerradas à força ficam de fora. Só lê esses metadados, nunca os passos.
import { join } from 'node:path';
import type { LiveSession } from '../poll/source';
import { openReadOnly, parseDbTime } from '../sqlite';

/** Conversa ociosa há menos que isto ainda está no escritório. */
export const ANTIGRAVITY_OPEN_MS = 30 * 60_000;
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

export function defaultAntigravityDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_DIR?.trim() || join(home, '.gemini', 'antigravity');
}

/** "file:///h%3A/projeto" vira "h:/projeto" (e "file:///home/u/p", "/home/u/p"). */
export function workspacePath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  let p: string;
  try {
    p = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
  const path = /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  return path || undefined;
}

function firstWorkspace(json: string): string | undefined {
  try {
    const list = JSON.parse(json) as unknown;
    if (Array.isArray(list)) for (const u of list) if (typeof u === 'string') return workspacePath(u);
  } catch {
    // coluna vazia ou malformada
  }
  return undefined;
}

interface Row {
  conversation_id: string;
  title: string;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  killed: number | null;
  last_user_input_time: string | null;
}

export function scanAntigravity(dir: string, now: number = Date.now()): LiveSession[] {
  const db = openReadOnly(join(dir, 'conversation_summaries.db'));
  try {
    const rows = db
      .prepare("SELECT conversation_id, title, last_modified_time, workspace_uris, status, killed, last_user_input_time FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 200")
      .all() as unknown as Row[];
    const out: LiveSession[] = [];
    for (const r of rows) {
      if (r.killed) continue;
      const modified = parseDbTime(r.last_modified_time);
      if (modified === undefined) continue;
      const working = r.status === RUNNING;
      if (!working && now - modified > ANTIGRAVITY_OPEN_MS) continue;
      const cwd = firstWorkspace(r.workspace_uris);
      if (!cwd) continue;
      out.push({ sessionId: r.conversation_id, cwd, title: r.title || undefined, working, startedAt: parseDbTime(r.last_user_input_time) ?? modified });
    }
    return out;
  } finally {
    db.close();
  }
}
