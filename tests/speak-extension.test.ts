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
  const statuses: Array<[string, string | undefined]> = [];
  const selections: string[] = [];
  const confirmations: boolean[] = [];
  const inputs: string[] = [];
  const ctx = { modelRegistry: overrides.modelRegistry, mode, hasUI: mode === 'tui', isIdle: () => true, sessionManager: { getHeader: () => overrides.header ?? { type: 'session' }, getBranch: () => overrides.branch ?? [{ type: 'message', message }] }, ui: { setStatus: (key: string, text?: string) => statuses.push([key, text]), notify: (text: string) => notifications.push(text), confirm: async () => confirmations.shift() ?? false, select: async () => selections.shift(), input: async () => inputs.shift() } };
  gentleSpeak({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut), registerTool: (tool: any) => tools.set(tool.name, tool) } as any, home, overrides.dependencies);
  return { home, events, commands, shortcuts, tools, notifications, statuses, selections, confirmations, inputs, ctx, close: () => rmSync(home, { recursive: true, force: true }) };
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

test('enabled all settled response plays sanitized prose and reports playback errors but not cancellation', async () => {
  const writes: string[] = [];
  const children: any[] = [];
  const branch = [
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'SECRET_TOOL' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'end_turn', content: [{ type: 'text', text: 'Resultado listo.\n```sh\nSECRET_CODE\n```' }] } },
  ];
  const h = harness('tui', { branch, dependencies: {
    modelStatus: async () => ({ state: 'installed', path: '/verified/model' }),
    runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }),
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(line); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      children.push(child);
      return child;
    },
  } });
  try {
    writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all' }));
    const settled = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.equal(JSON.parse(writes[0]).text, 'Resultado listo.');
    assert.doesNotMatch(writes[0], /SECRET_TOOL|SECRET_CODE/);
    children[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: 1 }) + '\n');
    await settled;
    assert.deepEqual(h.notifications, []);
    const failed = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    children[1].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'error', id: 2 }) + '\n');
    await failed;
    assert.deepEqual(h.notifications, ['Audio playback failed.']);
    const cancelled = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    h.events.get('session_shutdown')!({}, h.ctx);
    await cancelled;
    assert.deepEqual(h.notifications, ['Audio playback failed.']);
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

// ---- T12 (S7): SPEAK status row, cycle-voice shortcut, catalog voice menu ----
const settingsFile = (h: { home: string }) => join(h.home, 'speak-settings.json');
const save = (h: { home: string }, patch: Record<string, unknown>) => writeFileSync(settingsFile(h), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, ...patch }));
const saved = (h: { home: string }) => JSON.parse(readFileSync(settingsFile(h), 'utf8'));
const piperOnly = { modelStatus: async ({ voice }: any) => ({ state: voice === 'es_MX' ? 'installed' : 'missing', path: '/m' }), qwenStatus: async () => ({ manifest: 'missing', voices: {} }) };
const qwenReady = (installed: string[]) => ({ modelStatus: async ({ voice }: any) => ({ state: 'installed', path: '/m' }), qwenStatus: async () => ({ manifest: 'valid', voices: Object.fromEntries(['qwen-suave', 'qwen-brisa', 'qwen-coqueta', 'qwen-maestra', 'qwen-intima', 'qwen-serena', 'qwen-viva'].map(id => [id, installed.includes(id) ? 'installed' : 'missing'])) }) });
const last = (h: { statuses: Array<[string, string | undefined]> }) => h.statuses.at(-1);

test('session start sets the SPEAK row in both states with default keys', async () => {
  const h = harness();
  try {
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    assert.deepEqual(last(h), ['gentle-speak', 'SPEAK ○ off · Español (México) · ctrl+alt+m on/off · ctrl+alt+n voz']);
    save(h, { enabled: true, voice: 'qwen-brisa' });
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    assert.deepEqual(last(h), ['gentle-speak', 'SPEAK ● on · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz']);
  } finally { h.close(); }
});

test('the row reflects custom configured keys', async () => {
  const h = harness();
  try {
    save(h, { shortcuts: { ...DEFAULT_SPEAK_SETTINGS.shortcuts, toggle: 'ctrl+alt+x', cycleVoice: 'ctrl+alt+y' } });
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    assert.match(last(h)![1]!, /ctrl\+alt\+x on\/off · ctrl\+alt\+y voz/);
  } finally { h.close(); }
});

test('the toggle shortcut still toggles the setting and now refreshes the row', async () => {
  const h = harness();
  try {
    await h.shortcuts.get('ctrl+alt+m').handler(h.ctx);
    assert.equal(saved(h).enabled, true);
    assert.match(last(h)![1]!, /^SPEAK ● on/);
    await h.shortcuts.get('ctrl+alt+m').handler(h.ctx);
    assert.equal(saved(h).enabled, false);
    assert.match(last(h)![1]!, /^SPEAK ○ off/);
  } finally { h.close(); }
});

test('the toggle shortcut does nothing in a non-TUI session', async () => {
  const h = harness('rpc');
  try {
    await h.shortcuts.get('ctrl+alt+m').handler(h.ctx);
    assert.equal(existsSync(settingsFile(h)), false);
    assert.deepEqual(h.statuses, []);
  } finally { h.close(); }
});

test('the /speak toggle entry still toggles and refreshes the row', async () => {
  const h = harness();
  try {
    h.selections.push('Toggle auto-speak');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).enabled, true);
    assert.deepEqual(h.notifications, ['Speech settings saved.']);
    assert.match(last(h)![1]!, /^SPEAK ● on/);
  } finally { h.close(); }
});

test('other /speak entries keep their behavior (mode, speed)', async () => {
  const h = harness();
  try {
    h.selections.push('Mode: all');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).mode, 'all');
    h.selections.push('Speed'); h.inputs.push('1.5');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).speed, 1.5);
    assert.equal(saved(h).voice, 'es_MX');
    assert.deepEqual(h.notifications, ['Speech settings saved.', 'Speech settings saved.']);
  } finally { h.close(); }
});

test('the /speak menu lists every catalog voice with label, id and install state, and keeps the other entries', async () => {
  const h = harness('tui', { dependencies: qwenReady(['qwen-brisa']) });
  let offered: string[] = [];
  h.ctx.ui.select = async (_title: string, options: string[]) => { offered = options; return 'Cancel'; };
  try {
    await h.commands.get('speak').handler('', h.ctx);
    const voices = offered.filter(option => option.startsWith('Voice: '));
    assert.equal(voices.length, 9);
    assert.equal(voices[0], 'Voice: Español (México) (es_MX) — installed');
    assert.equal(voices[4], 'Voice: Coqueta (qwen-coqueta) — not installed');
    assert.equal(voices[3], 'Voice: Brisa (qwen-brisa) — installed');
    assert.equal(voices.some(option => option === 'Voice: es_MX' || option === 'Voice: es_ES'), false);
    assert.deepEqual(offered.filter(option => !option.startsWith('Voice: ')), ['Toggle auto-speak', 'Mode: all', 'Mode: questions-and-results', 'Mode: summary', 'Summary model', 'Speed', 'Key: speakLast', 'Key: stop', 'Key: toggle', 'Key: cycleVoice', 'Install voice and runtime', 'Stop playback', 'Cancel']);
  } finally { h.close(); }
});

test('selecting an installed voice persists it and refreshes the row', async () => {
  const h = harness('tui', { dependencies: qwenReady(['qwen-brisa']) });
  try {
    h.selections.push('Voice: Brisa (qwen-brisa) — installed');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).voice, 'qwen-brisa');
    assert.deepEqual(h.notifications, ['Speech settings saved.']);
    assert.match(last(h)![1]!, /^SPEAK ○ off · Brisa · /);
  } finally { h.close(); }
});

test('selecting an uninstalled voice explains how to install it and does not switch', async () => {
  const h = harness('tui', { dependencies: qwenReady([]) });
  try {
    h.selections.push('Voice: Brisa (qwen-brisa) — not installed');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(existsSync(settingsFile(h)), false);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0], /Brisa.*not installed.*README/s);
    assert.deepEqual(h.statuses, []);
  } finally { h.close(); }
});

test('the cycleVoice rebind accepts a free key and rejects reserved or duplicate keys', async () => {
  const h = harness();
  try {
    for (const bad of ['ctrl+k', 'ctrl+alt+m']) {
      h.selections.push('Key: cycleVoice'); h.inputs.push(bad);
      await h.commands.get('speak').handler('', h.ctx);
      assert.equal(existsSync(settingsFile(h)), false);
      assert.equal(h.notifications.at(-1), 'Invalid speech settings; nothing was saved.');
    }
    h.selections.push('Key: cycleVoice'); h.inputs.push('ctrl+alt+y');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).shortcuts.cycleVoice, 'ctrl+alt+y');
    assert.match(h.notifications.at(-1)!, /reload/);
    assert.match(last(h)![1]!, /ctrl\+alt\+y voz/);
  } finally { h.close(); }
});

test('the cycle shortcut is registered on the configured key and skips unavailable voices, wrapping', async () => {
  const h = harness('tui', { dependencies: qwenReady(['qwen-brisa', 'qwen-viva']) });
  try {
    assert.ok(h.shortcuts.has('ctrl+alt+n'));
    const cycle = () => h.shortcuts.get('ctrl+alt+n').handler(h.ctx);
    await cycle(); assert.equal(saved(h).voice, 'es_ES');
    await cycle(); assert.equal(saved(h).voice, 'qwen-brisa');
    assert.equal(h.notifications.at(-1), 'Voice: Brisa');
    assert.match(last(h)![1]!, /Brisa/);
    await cycle(); assert.equal(saved(h).voice, 'qwen-viva');
    await cycle(); assert.equal(saved(h).voice, 'es_MX');
  } finally { h.close(); }
});

test('cycling skips qwen voices when the manifest is not valid', async () => {
  const h = harness('tui', { dependencies: { modelStatus: async () => ({ state: 'installed', path: '/m' }), qwenStatus: async () => ({ manifest: 'invalid', voices: { 'qwen-brisa': 'installed' } }) } });
  try {
    await h.shortcuts.get('ctrl+alt+n').handler(h.ctx);
    assert.equal(saved(h).voice, 'es_ES');
    await h.shortcuts.get('ctrl+alt+n').handler(h.ctx);
    assert.equal(saved(h).voice, 'es_MX');
  } finally { h.close(); }
});

test('cycling with no alternative changes nothing and notifies', async () => {
  const h = harness('tui', { dependencies: piperOnly });
  try {
    await h.shortcuts.get('ctrl+alt+n').handler(h.ctx);
    assert.equal(existsSync(settingsFile(h)), false);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0], /No other voice is installed/);
  } finally { h.close(); }
});

test('the cycle shortcut does nothing in a non-TUI session', async () => {
  const h = harness('json', { dependencies: qwenReady(['qwen-brisa']) });
  try {
    await h.shortcuts.get('ctrl+alt+n').handler(h.ctx);
    assert.equal(existsSync(settingsFile(h)), false);
    assert.deepEqual(h.notifications, []);
  } finally { h.close(); }
});

test('shutdown clears the row, and nothing is set afterwards', async () => {
  const h = harness();
  try {
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    h.events.get('session_shutdown')!({ reason: 'reload' }, h.ctx);
    assert.deepEqual(last(h), ['gentle-speak', undefined]);
    const count = h.statuses.length;
    await h.shortcuts.get('ctrl+alt+m').handler(h.ctx);
    assert.equal(h.statuses.length, count);
  } finally { h.close(); }
});

test('no row is ever set in rpc, print, json or child sessions', async () => {
  for (const h of [harness('rpc'), harness('print'), harness('json'), harness('tui', { header: { type: 'session', parentSession: '/parent.jsonl' } })]) {
    try {
      await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
      h.events.get('session_shutdown')!({ reason: 'quit' }, h.ctx);
      assert.deepEqual(h.statuses, []);
    } finally { h.close(); }
  }
});

// Previous behavior preserved: an uninstalled Piper voice is still selectable,
// because "/speak → Install voice and runtime" installs the selected voice.
import { readFileSync as readSettingsRaw } from 'node:fs';
import { VOICE_CATALOG as PIPER_CATALOG } from '../lib/speak-voices.ts';
test('selecting an uninstalled Piper voice still switches so it can be installed', async () => {
  const h = harness('tui', { dependencies: piperOnly });
  try {
    h.selections.push(`Voice: ${PIPER_CATALOG.es_ES.label} (es_ES) — not installed`);
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(JSON.parse(readSettingsRaw(settingsFile(h), 'utf8')).voice, 'es_ES');
    assert.match(h.notifications.join('\n'), /Install voice and runtime/);
  } finally { h.close(); }
});
