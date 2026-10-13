// Terminal do Cline: converte o arquivo de mensagens da sessão (`<id>.messages.json`, UM documento JSON que o Cline
// regrava a cada mensagem, no formato de blocos do Claude: text, thinking, tool_use, tool_result) em TerminalEntry.
// Como não é JSONL, o parser implementa `parseWhole` (o terminal relê o arquivo e manda só as entradas novas, por id).
//
// - prompts do usuário vêm embrulhados em `<user_input mode="act">…</user_input>` (e comandos de barra em
//   `<user_command slash="…">…</user_command>`): o invólucro sai;
// - as ferramentas do Cline (run_commands, read_files, editor, apply_patch...) ganham um título "nome(argumento)" com o
//   primeiro argumento que faz sentido (comando, caminho, consulta...) e os argumentos em JSON;
// - o resultado vem como texto ou como lista de {query, result, error, success}; qualquer falha marca o resultado como erro;
// - segredos mascarados e textos truncados com as mesmas regras do terminal do Claude Code.
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { INPUT_MAX, marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, TITLE_ARG_MAX, type TerminalParser } from '../terminal';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

const USER_INPUT = /^\s*<user_input\b[^>]*>([\s\S]*?)<\/user_input>\s*$/;
const USER_COMMAND = /^\s*<user_command\b[^>]*\bslash="([^"]+)"[^>]*>([\s\S]*?)<\/user_command>\s*$/;

/** O texto que o usuário digitou, sem o invólucro que o Cline põe. */
export function userText(raw: string): string {
  const cmd = USER_COMMAND.exec(raw);
  if (cmd) return `${cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`}${cmd[2].trim() ? ` ${cmd[2].trim()}` : ''}`;
  const m = USER_INPUT.exec(raw);
  return (m ? m[1] : raw).trim();
}

/** Argumento que identifica a chamada: o primeiro valor útil dos campos de uso mais comum. */
function mainArg(input: Rec): string | undefined {
  const first = (v: unknown): string | undefined => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) {
      const x = v[0];
      return typeof x === 'string' ? str(x) : (str(rec(x)?.path) ?? str(rec(x)?.command) ?? str(rec(x)?.query));
    }
    return undefined;
  };
  for (const k of ['cmd', 'command', 'commands', 'path', 'files', 'query', 'queries', 'question', 'url', 'skill', 'agentId', 'task', 'title', 'code', 'input']) {
    const a = first(input[k]);
    if (a) return a;
  }
  return undefined;
}

/** Título "nome(argumento)" e os argumentos mascarados e cortados (também usado nos pedidos de aprovação). */
export function clineInputView(name: string, input: Rec): { title: string; input?: string; inputKind?: TerminalInputKind } {
  const arg = mainArg(input);
  const shown = arg ? oneLine(arg, TITLE_ARG_MAX, false) : '';
  const title = shown ? `${name}(${shown})` : name;
  // patch e comandos longos: o texto todo; o resto, os argumentos em JSON
  const text = str(input.input) ?? str(input.cmd) ?? str(input.command);
  let raw: string | undefined;
  let kind: TerminalInputKind = 'json';
  if (text && /^\*\*\* Begin Patch/.test(text)) {
    raw = text;
    kind = 'diff';
  } else if (Object.keys(input).length) {
    try {
      raw = JSON.stringify(input, null, 2);
    } catch {
      raw = undefined;
    }
  }
  if (!raw) return { title };
  const body = marked(prepare(raw, INPUT_MAX, Infinity, false));
  return body ? { title, input: body, inputKind: kind } : { title };
}

/** Resultado de uma ferramenta em texto; `error` = alguma parte falhou. */
function resultView(content: unknown): { text: string; error: boolean } {
  if (typeof content === 'string') return { text: content, error: false };
  if (!Array.isArray(content)) return { text: '', error: false };
  const parts: string[] = [];
  let error = false;
  for (const raw of content) {
    const r = rec(raw);
    if (!r) {
      if (typeof raw === 'string') parts.push(raw);
      continue;
    }
    const failed = r.success === false || typeof r.error === 'string';
    if (failed) error = true;
    const body = str(r.error) ?? str(r.result) ?? str(r.text) ?? '';
    const head = str(r.query);
    parts.push(head && content.length > 1 ? `${head}\n${body}`.trimEnd() : head && !body ? head : body);
  }
  return { text: parts.join('\n\n'), error };
}

/** Converte o documento inteiro; mensagem ou bloco que não dá para ler é pulado. Os ids são estáveis entre leituras. */
export function parseClineMessages(text: string): TerminalEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const messages = rec(doc)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: TerminalEntry[] = [];
  let lastAt = 0;
  messages.forEach((raw, mi) => {
    const m = rec(raw);
    if (!m || !Array.isArray(m.content)) return;
    const at = toMs(m.ts) ?? lastAt;
    lastAt = at;
    const mid = str(m.id) ?? `m${mi}`;
    m.content.forEach((rawBlock, bi) => {
      const b = rec(rawBlock);
      if (!b) return;
      const id = `${mid}:${bi}`;
      switch (b.type) {
        case 'text': {
          const t = str(b.text);
          if (!t) return;
          if (m.role === 'user') {
            const p = prepare(userText(t), TEXT_MAX);
            if (p.text) out.push({ kind: 'user', id, at, text: marked(p) });
          } else {
            const p = prepare(t, TEXT_MAX);
            if (p.text) out.push({ kind: 'assistant', id, at, text: marked(p) });
          }
          return;
        }
        case 'thinking': {
          const p = prepare(str(b.thinking) ?? '', THINKING_MAX);
          out.push(p.text ? { kind: 'thinking', id, at, text: marked(p) } : { kind: 'thinking', id, at });
          return;
        }
        case 'tool_use': {
          const name = str(b.name) ?? 'ferramenta';
          let input = rec(b.input);
          if (!input && typeof b.input === 'string') {
            try {
              input = rec(JSON.parse(b.input));
            } catch {
              input = undefined;
            }
          }
          out.push({ kind: 'tool', id: str(b.id) ?? id, at, tool: name, ...clineInputView(name, input ?? {}) });
          return;
        }
        case 'tool_result': {
          const r = resultView(b.content);
          const p = prepare(r.text, RESULT_MAX, RESULT_MAX_LINES);
          const toolUseId = str(b.tool_use_id) ?? id;
          out.push({ kind: 'result', id: `${toolUseId}:result`, at, toolUseId, text: p.text, ...(r.error ? { error: true } : {}), ...(p.truncated ? { truncated: true } : {}) });
          return;
        }
        case 'image':
        case 'file':
          out.push({ kind: 'system', id, at, text: b.type === 'image' ? tr('[imagem anexada]') : str(b.name) ? tr('[arquivo anexado: {0}]', [oneLine(String(b.name), 80, false)]) : tr('[arquivo anexado]'), level: 'info' });
          return;
      }
    });
  });
  return out;
}

/** Parser do terminal do Cline (o terminal usa `parseWhole`; `push` não é usado, o arquivo não é JSONL). */
export function createClineTerminalParser(): TerminalParser {
  return { push: () => [], parseWhole: parseClineMessages };
}
