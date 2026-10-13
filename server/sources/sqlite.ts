// SQLite só leitura para as fontes leves (Cline, Antigravity). `node:sqlite` vem com o Node 22.5+ (sem flag desde a
// 22.13): é carregado sob demanda para o servidor continuar subindo, sem essas fontes, num Node mais velho.
import { createRequire } from 'node:module';

interface Statement {
  all(...params: unknown[]): unknown[];
}
export interface ReadOnlyDb {
  prepare(sql: string): Statement;
  close(): void;
}

export function openReadOnly(path: string): ReadOnlyDb {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => ReadOnlyDb };
  return new DatabaseSync(path, { readOnly: true });
}

/** O processo existe? (EPERM = existe, de outro usuário.) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Data de uma coluna SQLite (ISO ou "2026-10-12 19:30:37.8657423+00:00") em epoch ms. */
export function parseDbTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let iso = v.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!/(Z|[+-]\d\d:\d\d)$/.test(iso)) iso += 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}
