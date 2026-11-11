import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermetic } from './helpers/hermetic.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.' }] };
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
  const ctx = { cwd: '/work/gentle-theme', modelRegistry: overrides.modelRegistry, mode, hasUI: mode === 'tui', isIdle: () => true, sessionManager: { getHeader: () => overrides.header ?? { type: 'session' }, getBranch: () => overrides.branch ?? [{ type: 'message', message }] }, ui: { setStatus: (key: string, text?: string) => statuses.push([key, text]), notify: (text: string) => notifications.push(text), confirm: async () => confirmations.shift() ?? false, select: async () => selections.shift(), input: async () => inputs.shift() } };
  // Hermetic: never probe the real herdr or osascript; the lock dir is the (temp) home.
  gentleSpeak({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut), registerTool: (tool: any) => tools.set(tool.name, tool) } as any, home, { focusCheck: async () => 'focused', sayAvailable: () => false, ...hermetic(home), env: {}, ...overrides.dependencies });
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
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.\n```sh\nSECRET_CODE\n```' }] } },
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
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.\n```sh\nPRIVATE_CODE\n```\n+PRIVATE_DIFF\n`PRIVATE_INLINE`' }] } },
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
    assert.deepEqual(last(h), ['gentle-speak', 'SPEAK ○ off · modo preguntas y resultados · Español (México) · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c']);
    save(h, { enabled: true, voice: 'qwen-brisa' });
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    assert.deepEqual(last(h), ['gentle-speak', 'SPEAK ● on · modo preguntas y resultados · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c']);
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
    assert.equal(voices.length, 10);
    assert.equal(voices[9], 'Voice: Mac (mac) — not installed');
    assert.equal(voices[0], 'Voice: Español (México) (es_MX) — installed');
    assert.equal(voices[4], 'Voice: Coqueta (qwen-coqueta) — not installed');
    assert.equal(voices[3], 'Voice: Brisa (qwen-brisa) — installed');
    assert.equal(voices.some(option => option === 'Voice: es_MX' || option === 'Voice: es_ES'), false);
    assert.deepEqual(offered.slice(0, 1), ['Gentle Dot']);
    assert.equal(offered.includes('Hablar en Gentle Dot'), false);
    assert.deepEqual(offered.slice(1).filter(option => !option.startsWith('Voice: ')), ['Toggle auto-speak', 'Mode: all', 'Mode: questions-and-results', 'Mode: summary', 'Summary model', 'Speed', 'Key: speakLast', 'Key: stop', 'Key: toggle', 'Key: cycleVoice', 'Key: toggleCopy', 'Install voice and runtime', 'Toggle speak copied selection', 'Stop playback', 'Cancel'].flatMap(entry => entry === 'Speed' ? ['Mac voice', 'Toggle Mac fallback', 'Liberar Qwen tras inactividad', 'Detener servicio Qwen', entry] : [entry]));
  } finally { h.close(); }
});

test('selecting an installed voice persists it and refreshes the row', async () => {
  const h = harness('tui', { dependencies: qwenReady(['qwen-brisa']) });
  try {
    h.selections.push('Voice: Brisa (qwen-brisa) — installed');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).voice, 'qwen-brisa');
    assert.deepEqual(h.notifications, ['Speech settings saved.']);
    assert.match(last(h)![1]!, /^SPEAK ○ off · modo preguntas y resultados · Brisa · /);
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

// S8: speak copied selection wiring.
function copyHarness(over: { tui?: unknown; terminal?: string | undefined; mode?: string; header?: unknown; on?: boolean } = {}) {
  const watchers: Array<{ opts: any; starts: number; stops: number }> = [];
  const widgets: Array<[string, unknown]> = [];
  const resolved: number[] = [];
  const h = harness(over.mode ?? 'tui', { header: over.header, dependencies: {
    ...qwenReady(['qwen-brisa']),
    runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
    resolveTerminal: async () => { resolved.push(1); return 'terminal' in over ? over.terminal : 'com.term'; },
    createWatcher: (opts: any) => { const w = { opts, starts: 0, stops: 0 }; watchers.push(w); return { start: () => { w.starts++; }, stop: () => { w.stops++; } }; },
  } });
  const tui = 'tui' in over ? over.tui : { getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => ['x'] };
  (h.ctx.ui as any).setWidget = (key: string, factory: any) => { widgets.push([key, factory]); if (typeof factory === 'function') factory(tui, {}); };
  if (over.on !== false) save(h, { copySpeech: true });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return Object.assign(h, { watchers, widgets, resolved, settle });
}

test('the watcher starts only when copySpeech is on in the interactive parent', async () => {
  const h = copyHarness();
  try {
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    await h.settle();
    assert.equal(h.watchers.length, 1);
    assert.equal(h.watchers[0].starts, 1);
    assert.equal(h.watchers[0].opts.terminalBundleId, 'com.term');
    assert.equal(typeof h.watchers[0].opts.isOwnCopy, 'function');
    assert.deepEqual(h.notifications, []);
  } finally { h.close(); }
  const off = copyHarness({ on: false });
  try {
    await off.events.get('session_start')!({ reason: 'startup' }, off.ctx);
    await off.settle();
    assert.equal(off.watchers.length, 0);
    assert.deepEqual(off.widgets, []);
  } finally { off.close(); }
  for (const other of [copyHarness({ mode: 'rpc' }), copyHarness({ mode: 'print' }), copyHarness({ mode: 'json' }), copyHarness({ header: { type: 'session', parentSession: '/p.jsonl' } })]) {
    try {
      await other.events.get('session_start')!({ reason: 'startup' }, other.ctx);
      await other.settle();
      assert.equal(other.watchers.length, 0);
      assert.equal(other.resolved.length, 0);
    } finally { other.close(); }
  }
});

test('the widget renders no visible content and the gate reads the captured tui', async () => {
  let selecting = true;
  const tui = { getCopyOnSelect: () => true, hasActiveSelection: () => selecting, getScreenLines: () => ['copiado aqui'] };
  const h = copyHarness({ tui });
  let component: any;
  try {
    const original = (h.ctx.ui as any).setWidget;
    (h.ctx.ui as any).setWidget = (key: string, factory: any, options: any) => { original(key, (t: any, th: any) => (component = factory(t, th)), options); };
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    await h.settle();
    assert.deepEqual(component.render(80), []);
    const gate = h.watchers[0].opts.isOwnCopy;
    assert.equal(gate('copiado aqui'), true);
    selecting = false;
    assert.equal(gate('copiado aqui'), false);
  } finally { h.close(); }
});

test('turning the option off from /speak stops the watcher and persists; on restarts it with a privacy note', async () => {
  const h = copyHarness({ on: false });
  try {
    h.selections.push('Toggle speak copied selection');
    await h.commands.get('speak').handler('', h.ctx);
    await h.settle();
    assert.equal(saved(h).copySpeech, true);
    assert.equal(h.watchers.length, 1);
    assert.equal(h.watchers[0].starts, 1);
    assert.match(h.notifications.join('\n'), /on.*only copies made in this Gentle Shell.*(concealed|password)/i);
    h.selections.push('Toggle speak copied selection');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).copySpeech, false);
    assert.equal(h.watchers[0].stops, 1);
    assert.match(h.notifications.at(-1)!, /off/i);
    h.selections.push('Toggle speak copied selection');
    await h.commands.get('speak').handler('', h.ctx);
    await h.settle();
    assert.equal(h.watchers.length, 2);
    assert.equal(h.watchers[1].starts, 1);
  } finally { h.close(); }
});

test('shutdown stops the watcher', async () => {
  const h = copyHarness();
  try {
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    await h.settle();
    h.events.get('session_shutdown')!({ reason: 'reload' }, h.ctx);
    assert.equal(h.watchers[0].stops, 1);
  } finally { h.close(); }
});

test('an unresolvable terminal or a non-fullscreen TUI notifies once and does not start', async () => {
  const noTerm = copyHarness({ terminal: undefined });
  try {
    await noTerm.events.get('session_start')!({ reason: 'startup' }, noTerm.ctx);
    await noTerm.settle();
    assert.equal(noTerm.watchers.reduce((n, w) => n + w.starts, 0), 0);
    assert.equal(noTerm.notifications.length, 1);
    assert.match(noTerm.notifications[0], /terminal/i);
  } finally { noTerm.close(); }
  const plain = copyHarness({ tui: { render: () => [] } });
  try {
    await plain.events.get('session_start')!({ reason: 'startup' }, plain.ctx);
    await plain.settle();
    assert.equal(plain.watchers.reduce((n, w) => n + w.starts, 0), 0);
    assert.equal(plain.notifications.length, 1);
    assert.match(plain.notifications[0], /unavailable in this terminal mode/);
    await plain.events.get('session_start')!({ reason: 'startup' }, plain.ctx);
    await plain.settle();
    assert.equal(plain.notifications.filter(n => /unavailable in this terminal mode/.test(n)).length, 1, 'reported once');
  } finally { plain.close(); }
});

test('copy speech uses the current voice path and cancels playback like a manual speak', async () => {
  const writes: string[] = [];
  const children: any[] = [];
  const h = copyHarness();
  try {
    // Rebuild with a spawn recorder: the copy harness deps are fixed, so use a dedicated one.
  } finally { h.close(); }
  const watchers: any[] = [];
  const g = harness('tui', { dependencies: {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
    spawn: () => { const c = Object.assign(new EventEmitter(), { stdin: { write: (l: string) => { writes.push(l); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill() { this.killed++; return true; } }); children.push(c); return c; },
    resolveTerminal: async () => 'com.term',
    createWatcher: (opts: any) => { watchers.push(opts); return { start() {}, stop() {} }; },
  } });
  try {
    (g.ctx.ui as any).setWidget = (_k: string, f: any) => { f({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => [] }, {}); };
    save(g, { copySpeech: true, voice: 'es_ES' });
    await g.events.get('session_start')!({ reason: 'startup' }, g.ctx);
    await new Promise(resolve => setImmediate(resolve));
    watchers[0].speak('primera');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(writes[0]).text, 'primera');
    assert.equal(JSON.parse(writes[0]).model.name, 'es_ES-davefx-medium.onnx');
    watchers[0].speak('segunda');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children[0].killed >= 1, true, 'previous playback cancelled');
    assert.equal(JSON.parse(writes[1]).text, 'segunda');
  } finally { g.events.get('session_shutdown')!({ reason: 'quit' }, g.ctx); g.close(); }
});

test('the SPEAK row always shows the copy state and its key, in both states', async () => {
  const h = copyHarness();
  try {
    await h.events.get('session_start')!({ reason: 'startup' }, h.ctx);
    assert.match(last(h)![1]!, / · copia ● ctrl\+alt\+c$/);
  } finally { h.close(); }
  const off = copyHarness({ on: false });
  try {
    await off.events.get('session_start')!({ reason: 'startup' }, off.ctx);
    assert.match(last(off)![1]!, / · copia ○ ctrl\+alt\+c$/);
  } finally { off.close(); }
});

test('the toggleCopy key toggles and persists copySpeech with the /speak notify text, runs syncCopy and refreshes the row', async () => {
  const h = copyHarness({ on: false });
  try {
    assert.ok(h.shortcuts.has('ctrl+alt+c'));
    await h.shortcuts.get('ctrl+alt+c').handler(h.ctx);
    await h.settle();
    assert.equal(saved(h).copySpeech, true);
    assert.equal(h.notifications.at(-1), 'Speak copied selection: on. Only copies made in this Gentle Shell are spoken; concealed/password copies are skipped.');
    assert.match(last(h)![1]!, / · copia ● ctrl\+alt\+c$/);
    assert.equal(h.watchers.length, 1);
    assert.equal(h.watchers[0].starts, 1);
    await h.shortcuts.get('ctrl+alt+c').handler(h.ctx);
    assert.equal(saved(h).copySpeech, false);
    assert.equal(h.notifications.at(-1), 'Speak copied selection: off.');
    assert.match(last(h)![1]!, / · copia ○ ctrl\+alt\+c$/);
    assert.equal(h.watchers[0].stops, 1);
  } finally { h.close(); }
});

test('the toggleCopy key does nothing in a non-TUI session', async () => {
  const rpc = harness('rpc');
  try {
    await rpc.shortcuts.get('ctrl+alt+c').handler(rpc.ctx);
    assert.equal(existsSync(settingsFile(rpc)), false);
    assert.deepEqual(rpc.statuses, []);
  } finally { rpc.close(); }
});

test('the toggleCopy rebind in /speak accepts a free key and rejects reserved or duplicate keys', async () => {
  const h = harness();
  try {
    for (const bad of ['ctrl+k', 'ctrl+alt+m', 'ctrl+alt+n', 'c']) {
      h.selections.push('Key: toggleCopy'); h.inputs.push(bad);
      await h.commands.get('speak').handler('', h.ctx);
      assert.equal(existsSync(settingsFile(h)), false);
      assert.equal(h.notifications.at(-1), 'Invalid speech settings; nothing was saved.');
    }
    h.selections.push('Key: toggleCopy'); h.inputs.push('ctrl+alt+q');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(saved(h).shortcuts.toggleCopy, 'ctrl+alt+q');
    assert.match(h.notifications.at(-1)!, /reload/);
    assert.match(last(h)![1]!, / · copia ○ ctrl\+alt\+q$/);
  } finally { h.close(); }
});

test('the /speak menu keeps its previous entries and the new one is added', async () => {
  const h = copyHarness({ on: false });
  let options: string[] = [];
  try {
    (h.ctx.ui as any).select = async (_title: string, items: string[]) => { options = items; return undefined; };
    await h.commands.get('speak').handler('', h.ctx);
    for (const entry of ['Toggle auto-speak', 'Mode: all', 'Summary model', 'Speed', 'Key: cycleVoice', 'Install voice and runtime', 'Stop playback', 'Cancel', 'Toggle speak copied selection']) assert.ok(options.includes(entry), entry);
  } finally { h.close(); }
});

test('Piper path: the audio worker error cause is shown as `Audio playback failed: <cause>.`; without a cause the bare message stays', async () => {
  for (const [extra, text] of [[{ cause: 'Sample rate update timed out' }, 'Audio playback failed: Sample rate update timed out.'], [{ cause: 'bad /Users/me/f now' }, 'Audio playback failed: bad now.'], [{ cause: 'y'.repeat(300) }, `Audio playback failed: ${'y'.repeat(120)}.`], [{}, 'Audio playback failed.'], [{ cause: 7 }, 'Audio playback failed.']] as const) {
    const children: any[] = [];
    const h = harness('tui', { branch: [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.' }] } }], dependencies: {
      modelStatus: async () => ({ state: 'installed', path: '/verified/model' }),
      runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }),
      spawn: () => { const child = Object.assign(new EventEmitter(), { stdin: { write: () => true }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }); children.push(child); return child; },
    } });
    try {
      writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all' }));
      const settled = h.events.get('agent_settled')!({ aborted: false }, h.ctx);
      await new Promise(resolve => setImmediate(resolve));
      children[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'error', code: 'playback', id: 1, ...extra }) + '\n');
      await settled;
      assert.deepEqual(h.notifications, [text]);
    } finally { h.close(); }
  }
});
