// Sessões abertas do Cline (CLI, extensão e app desktop): ~/.cline/data/db/sessions.db (SQLite, só leitura).
// Uma sessão está aberta quando não tem `ended_at` nem status final e o processo dela (`pid`) está vivo; os
// subagentes (`is_subagent`) ficam de fora. "Trabalhando" = o arquivo de mensagens da sessão mudou há pouco.
// Nunca lê as mensagens, só a data de modificação do arquivo.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveSession } from '../poll/source';
import { openReadOnly, parseDbTime, pidAlive } from '../sqlite';

/** Mensagens gravadas há menos que isto = o Cline está trabalhando. */
export const CLINE_WORKING_MS = 20_000;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'aborted', 'error', 'stopped', 'exited']);

export function defaultClineDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLINE_DIR?.trim() || join(home, '.cline');
}

interface Row {
  session_id: string;
  pid: number;
  started_at: string;
  status: string;
  cwd: string;
  workspace_root: string;
  messages_path: string | null;
  updated_at: string | null;
}

export function scanCline(dir: string, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): LiveSession[] {
  const db = openReadOnly(join(dir, 'data', 'db', 'sessions.db'));
  try {
    const rows = db
      .prepare('SELECT session_id, pid, started_at, status, cwd, workspace_root, messages_path, updated_at FROM sessions WHERE ended_at IS NULL AND is_subagent = 0')
      .all() as unknown as Row[];
    const out: LiveSession[] = [];
    for (const r of rows) {
      if (FINAL.has(String(r.status).toLowerCase()) || !alive(Number(r.pid))) continue;
      const cwd = r.workspace_root || r.cwd;
      if (!cwd) continue;
      let last = parseDbTime(r.updated_at);
      if (r.messages_path) {
        try {
          last = Math.max(last ?? 0, statSync(r.messages_path).mtimeMs);
        } catch {
          // arquivo ainda não criado
        }
      }
      out.push({ sessionId: r.session_id, cwd, working: last !== undefined && now - last < CLINE_WORKING_MS, startedAt: parseDbTime(r.started_at) ?? now, ...(r.messages_path ? { transcriptPath: r.messages_path } : {}) });
    }
    return out;
  } finally {
    db.close();
  }
}
