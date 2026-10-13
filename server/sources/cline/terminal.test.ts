// Terminal do Cline: o documento de mensagens (blocos text, thinking, tool_use e tool_result) vira TerminalEntry.
import { describe, expect, it } from 'vitest';
import { createClineTerminalParser, parseClineMessages, userText } from './terminal';

const doc = (messages: unknown[]) => JSON.stringify({ version: 1, messages });
const T0 = 1_791_861_095_538;

const MESSAGES = [
  { id: 'u1', role: 'user', ts: T0, content: [{ type: 'text', text: '<user_input mode="act">oii</user_input>' }] },
  {
    id: 'a1',
    role: 'assistant',
    ts: T0 + 5_000,
    content: [
      { type: 'thinking', thinking: '**Saudação**\n\nResponder em português.' },
      { type: 'text', text: 'Oi! Como posso ajudar?' },
      { type: 'tool_use', id: 'call_1', name: 'run_commands', input: { commands: ['git status --short'] } },
    ],
  },
  { id: 'r1', role: 'user', ts: T0 + 6_000, content: [{ type: 'tool_result', tool_use_id: 'call_1', name: 'run_commands', content: [{ query: 'git status --short', result: ' M a.ts', success: true }] }] },
  { id: 'a2', role: 'assistant', ts: T0 + 7_000, content: [{ type: 'tool_use', id: 'call_2', name: 'search_codebase', input: { queries: ['foo', 'bar'] } }] },
  { id: 'r2', role: 'user', ts: T0 + 8_000, content: [{ type: 'tool_result', tool_use_id: 'call_2', name: 'search_codebase', content: [{ query: 'foo', result: '', error: 'Search failed: timeout', success: false }] }] },
];

describe('userText', () => {
  it('tira o invólucro do prompt e dos comandos de barra', () => {
    expect(userText('<user_input mode="plan">faça X</user_input>')).toBe('faça X');
    expect(userText('<user_command slash="compact">resumir</user_command>')).toBe('/compact resumir');
    expect(userText('texto solto')).toBe('texto solto');
  });
});

describe('parseClineMessages', () => {
  it('converte prompt, raciocínio, resposta, ferramenta e resultado com ids estáveis', () => {
    const e = parseClineMessages(doc(MESSAGES));
    expect(e.map((x) => [x.kind, x.id])).toEqual([
      ['user', 'u1:0'],
      ['thinking', 'a1:0'],
      ['assistant', 'a1:1'],
      ['tool', 'call_1'],
      ['result', 'call_1:result'],
      ['tool', 'call_2'],
      ['result', 'call_2:result'],
    ]);
    expect(e[0]).toMatchObject({ text: 'oii', at: T0 });
    expect(e[1]).toMatchObject({ text: expect.stringContaining('Saudação') });
    expect(e[2]).toMatchObject({ text: 'Oi! Como posso ajudar?' });
    expect(e[3]).toMatchObject({ tool: 'run_commands', title: 'run_commands(git status --short)', inputKind: 'json' });
    expect(e[4]).toMatchObject({ toolUseId: 'call_1', text: expect.stringContaining('M a.ts') });
    expect(e[4]).not.toHaveProperty('error');
    expect(e[5]).toMatchObject({ title: 'search_codebase(foo)' });
    expect(e[6]).toMatchObject({ error: true, text: 'Search failed: timeout' });
    // ids iguais numa releitura (o terminal só manda os novos)
    expect(parseClineMessages(doc(MESSAGES)).map((x) => x.id)).toEqual(e.map((x) => x.id));
  });

  it('o prompt do usuário sem o invólucro e o patch como diff', () => {
    const e = parseClineMessages(doc([{ id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'p', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch' } }] }]));
    expect(e[0]).toMatchObject({ kind: 'tool', tool: 'apply_patch', inputKind: 'diff' });
  });

  it('mascara segredos e aceita o input como texto JSON', () => {
    const e = parseClineMessages(
      doc([
        { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'exec', input: JSON.stringify({ cmd: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"' }) }] },
        { id: 'b', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }] },
      ]),
    );
    expect(JSON.stringify(e)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(e[0]).toMatchObject({ tool: 'exec', title: expect.stringMatching(/^exec\(curl/) });
  });

  it('imagens viram aviso; documento inválido ou incompleto, nada', () => {
    const e = parseClineMessages(doc([{ id: 'u', role: 'user', content: [{ type: 'image' }, { type: 'text', text: '<user_input mode="act">veja</user_input>' }] }]));
    expect(e.map((x) => x.kind)).toEqual(['system', 'user']);
    expect(parseClineMessages('{"messages": [')).toEqual([]);
    expect(parseClineMessages('lixo')).toEqual([]);
    expect(parseClineMessages('{"messages": 3}')).toEqual([]);
  });

  it('o parser do terminal expõe parseWhole', () => {
    const p = createClineTerminalParser();
    expect(p.push('x')).toEqual([]);
    expect(p.parseWhole?.(doc(MESSAGES)).length).toBe(7);
  });
});
