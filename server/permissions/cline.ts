// Pedidos de aprovação do Cline (evento `approval.requested` do hub dele): título, resumo, ícone e argumentos pelos
// nomes de ferramenta do Cline (run_commands, editor, apply_patch, read_files...). Tudo mascarado e cortado como no
// terminal.
import { maskSecrets, truncate } from '../../shared/activity';
import type { TerminalInputKind } from '../../shared/types';
import { clineInputView } from '../sources/cline/terminal';
import { tr } from '../../shared/i18n';

export interface ClineToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

const TEXT_MAX = 46;

/** [resumo, ícone] por ferramenta; o resto vira "Usar <nome>". */
const KNOWN: ReadonlyArray<[RegExp, () => string, string]> = [
  [/^(run_commands|exec|bash|shell|run_command)$/, () => tr('Rodar comando'), '💻'],
  [/^(apply_patch|editor|write_file|replace_in_file)$/, () => tr('Editar arquivos'), '✏️'],
  [/^read_files?$/, () => tr('Ler arquivos'), '📖'],
  [/^(search_codebase|search|grep)$/, () => tr('Buscar no código'), '🔍'],
  [/^(web_fetch|fetch|web_search|browser)$/, () => tr('Acessar a web'), '🌐'],
  [/^team_/, () => tr('Coordenar o time de agentes'), '🧑‍🤝‍🧑'],
];

export function clineToolView(tool: string, input: Record<string, unknown>): ClineToolView {
  const view = clineInputView(tool, input);
  const known = KNOWN.find(([re]) => re.test(tool));
  const text = known ? known[1]() : tr('Usar {0}', [tool]);
  return { title: view.title, text: truncate(maskSecrets(text), TEXT_MAX), icon: known?.[2] ?? '🔧', ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
}
