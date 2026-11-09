import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gentleSpeak from '../extensions/gentle-speak.ts';

const message = { role: 'assistant', stopReason: 'end_turn', content: [{ type: 'text', text: 'Resultado listo.' }] };
function harness(mode = 'tui', overrides: any = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-extension-'));
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const tools = new Map<string, any>();
  const notifications: string[] = [];
  const selections: string[] = [];
  const confirmations: boolean[] = [];
  const inputs: string[] = [];
  const ctx = { modelRegistry: overrides.modelRegistry, mode, hasUI: mode === 'tui', isIdle: () => true, sessionManager: { getHeader: () => overrides.header ?? { type: 'session' }, getBranch: () => overrides.branch ?? [{ type: 'message', message }] }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => confirmations.shift() ?? false, select: async () => selections.shift(), input: async () => inputs.shift() } };
  gentleSpeak({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut), registerTool: (tool: any) => tools.set(tool.name, tool) } as any, home, overrides.dependencies);
  return { home, events, commands, shortcuts, tools, notifications, selections, confirmations, inputs, ctx, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('startup and settled events remain silent with absent settings; non-TUI tool cannot play', async () => {
  const h = harness('rpc');
  try {
    assert.ok(h.events.has('agent_settled'));
    await h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    assert.equal(h.notifications.length, 0);
    const result = await h.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /interactive parent TUI/);
  } finally { h.close(); }
});

test('a forked session header with parentSession is silent even in TUI', async () => {
  const h = harness('tui', { header: { type: 'session', parentSession: '/parent.jsonl' } });
  try {
    const result = await h.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
  } finally { h.close(); }
});

test('manual speech verifies both installed roots before child creation and sends worker protocol', async () => {
  const writes: string[] = [];
  let created = 0;
  const child = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(line); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const dependencies = { modelStatus: async () => ({ state: 'installed', path: '/verified/model' }), runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }), spawn: () => { created++; return child; } };
  const h = harness('tui', { dependencies });
  try {
    const promise = h.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(created, 1);
    assert.deepEqual(JSON.parse(writes[0]), { schema: 'gentle.speak/v1', type: 'speak', id: 1, text: 'Hola', speed: 1, runtime: '/verified/runtime', model: { root: '/verified/model', name: 'es_MX-claude-high.onnx' } });
    child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: 1 }) + '\n');
    assert.equal((await promise).isError, undefined);
  } finally { h.close(); }
});

test('missing model never starts child and installing requires separate confirmations', async () => {
  let created = 0, installed = 0;
  const h = harness('tui', { dependencies: { modelStatus: async () => ({ state: 'missing', path: '/missing' }), runtimeStatus: async () => ({ state: 'missing', path: '/missing' }), spawn: () => { created++; }, installModel: async () => { installed++; }, installRuntime: async () => { installed++; } } });
  try {
    const result = await h.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    assert.equal(created, 0);
    h.selections.push('Install voice and runtime');
    h.confirmations.push(true, false);
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(installed, 1);
  } finally { h.close(); }
});

test('summary model is selected through /speak; absent model causes no model call', async () => {
  let calls = 0;
  const h = harness('tui', { modelRegistry: { find: () => ({}), hasConfiguredAuth: () => true, complete: async () => { calls++; return { content: [{ type: 'text', text: 'Listo.' }] }; }, getAvailable: () => [{ provider: 'openai', id: 'gpt-5.2' }] } });
  try {
    writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'summary' }));
    await h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    assert.equal(calls, 0);
    h.selections.push('Summary model', 'openai/gpt-5.2');
    await h.commands.get('speak').handler('', h.ctx);
    assert.deepEqual(JSON.parse((await import('node:fs')).readFileSync(join(h.home, 'speak-settings.json'), 'utf8')).summaryModel, { provider: 'openai', id: 'gpt-5.2' });
  } finally { h.close(); }
});

test('configured summary sends sanitized final prose and one sentence to verified worker IPC', async () => {
  const writes: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(line); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  let modelInput: any;
  const branch = [
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'end_turn', content: [{ type: 'text', text: 'Resultado listo.\n```sh\nPRIVATE_CODE\n```\n+PRIVATE_DIFF\n`PRIVATE_INLINE`' }] } },
  ];
  const h = harness('tui', { branch, modelRegistry: {
    find: (provider: string, id: string) => provider === 'openai' && id === 'gpt-5.2' ? { provider, id } : undefined,
    hasConfiguredAuth: () => true,
    complete: async (_model: any, context: any, options: any) => {
      modelInput = { context, options };
      return { content: [{ type: 'text', text: 'El resultado está listo.' }] };
    },
  }, dependencies: {
    modelStatus: async () => ({ state: 'installed', path: '/verified/model' }),
    runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }),
    spawn: () => child,
  } });
  try {
    writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'summary', summaryModel: { provider: 'openai', id: 'gpt-5.2' } }));
    const settled = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(modelInput.context.messages.length, 1);
    assert.equal(modelInput.context.messages[0].role, 'user');
    assert.match(modelInput.context.messages[0].content[0].text, /Resultado listo\./);
    assert.doesNotMatch(modelInput.context.messages[0].content[0].text, /PRIVATE_CODE|PRIVATE_DIFF|PRIVATE_INLINE|PRIVATE_TOOL_OUTPUT/);
    assert.equal(modelInput.options.signal.aborted, false);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0]), { schema: 'gentle.speak/v1', type: 'speak', id: 1, text: 'El resultado está listo.', speed: 1, runtime: '/verified/runtime', model: { root: '/verified/model', name: 'es_MX-claude-high.onnx' } });
    child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: 1 }) + '\n');
    await settled;
    assert.equal(modelInput.options.signal.aborted, true);
  } finally { h.close(); }
});

test('summary sends only sanitized final prose and shutdown aborts pending model call without playback', async () => {
  let prompt = '', signal: AbortSignal | undefined, created = 0;
  let complete!: (value: any) => void;
  const h = harness('tui', { modelRegistry: {
    find: () => ({ provider: 'openai', id: 'gpt-5.2' }), hasConfiguredAuth: () => true,
    complete: (_model: unknown, context: any, options: any) => { prompt = context.messages[0].content[0].text; signal = options.signal; return new Promise(resolve => { complete = resolve; }); },
  }, dependencies: { modelStatus: async () => ({ state: 'installed', path: '/model' }), runtimeStatus: async () => ({ state: 'installed', path: '/runtime' }), spawn: () => { created++; } } });
  try {
    writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'summary', summaryModel: { provider: 'openai', id: 'gpt-5.2' } }));
    const pending = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(prompt, /Resultado listo/);
    assert.equal(signal?.aborted, false);
    h.events.get('session_shutdown')!({}, h.ctx);
    assert.equal(signal?.aborted, true);
    complete({ content: [{ type: 'text', text: 'Una frase.' }] });
    await pending;
    assert.equal(created, 0);
  } finally { h.close(); }
});

test('shortcut changes reject reserved keys and preserve file; accepted changes require reload', async () => {
  const h = harness();
  try {
    h.selections.push('Key: stop'); h.inputs.push('ctrl+k');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal((await import('node:fs')).existsSync(join(h.home, 'speak-settings.json')), false);
    h.selections.push('Key: stop'); h.inputs.push('ctrl+alt+x');
    await h.commands.get('speak').handler('', h.ctx);
    assert.match(h.notifications.at(-1)!, /reload/);
    assert.equal(h.shortcuts.has('ctrl+alt+x'), false);
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, 'speak-settings.json'), 'utf8')).shortcuts, { ...DEFAULT_SPEAK_SETTINGS.shortcuts, stop: 'ctrl+alt+x' });
    assert.equal(JSON.parse(readFileSync(join(h.home, 'speak-settings.json'), 'utf8')).enabled, false);
  } finally { h.close(); }
});

test('settings command is TUI-only and exposes no install on noninteractive sessions', async () => {
  const h = harness('json');
  try {
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(h.notifications.length, 0);
  } finally { h.close(); }
});
