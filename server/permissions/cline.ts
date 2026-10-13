// Pedidos de aprovação do Cline (evento `approval.requested` do hub dele): título, resumo, ícone e argumentos pelos
// nomes de ferramenta do Cline (run_commands, editor, apply_patch, read_files...). Tudo mascarado e cortado como no
// terminal.
import { maskSecrets, truncate } from '../../shared/activity';
import type { TerminalInputKind } from '../../shared/types';
import { clineInputView } from '../sources/cline/terminal';

export interface ClineToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

const TEXT_MAX = 46;

/** [resumo, ícone] por ferramenta; o resto vira "Usar <nome>". */
const KNOWN: ReadonlyArray<[RegExp, string, string]> = [
  [/^(run_commands|exec|bash|shell|run_command)$/, 'Rodar comando', '💻'],
  [/^(apply_patch|editor|write_file|replace_in_file)$/, 'Editar arquivos', '✏️'],
  [/^read_files?$/, 'Ler arquivos', '📖'],
  [/^(search_codebase|search|grep)$/, 'Buscar no código', '🔍'],
  [/^(web_fetch|fetch|web_search|browser)$/, 'Acessar a web', '🌐'],
  [/^team_/, 'Coordenar o time de agentes', '🧑‍🤝‍🧑'],
];

export function clineToolView(tool: string, input: Record<string, unknown>): ClineToolView {
  const view = clineInputView(tool, input);
  const known = KNOWN.find(([re]) => re.test(tool));
  const text = known ? known[1] : `Usar ${tool}`;
  return { title: view.title, text: truncate(maskSecrets(text), TEXT_MAX), icon: known?.[2] ?? '🔧', ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
}
