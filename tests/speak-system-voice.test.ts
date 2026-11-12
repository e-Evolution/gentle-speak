import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  SYSTEM_DEFAULT_VOICE, buildSystemCommand, detectSystemEngine, listSystemVoices, parseSystemVoices, pickSystemVoice, resolveSystemVoice, speakWithSystemVoice,
  systemRate, systemVoiceAvailable, systemVoiceHint, systemVoiceLabel, systemVoiceStatus, POWERSHELL_SPEAK_SCRIPT, POWERSHELL_LIST_SCRIPT,
} from '../lib/speak-system-voice.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, readSpeakSettings } from '../lib/speak-settings.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speakWithSay } from '../lib/speak-say.ts';

const have = (...names: string[]) => (cmd: string) => names.includes(cmd) ? `/usr/bin/${cmd}` : undefined;

function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; env?: Record<string, string>; stdin: string[]; ended: boolean; killed: string[]; child: any }> = [];
  const spawn = (file: string, args: string[], options?: { env?: Record<string, string> }) => {
    const child: any = new EventEmitter();
    const rec = { file, args, env: options?.env, stdin: [] as string[], ended: false, killed: [] as string[], child };
    child.stdin = { write: (c: string) => { rec.stdin.push(c); return true; }, end: () => { rec.ended = true; }, on() {} };
    child.kill = (s?: string) => { rec.killed.push(s ?? 'SIGTERM'); return true; };
    calls.push(rec);
    return child;
  };
  return { calls, spawn };
}

test('engine per platform and per available tool', () => {
  assert.deepEqual(detectSystemEngine({ platform: 'darwin', exists: p => p === '/usr/bin/say' }), { engine: 'say', file: '/usr/bin/say' });
  assert.equal(detectSystemEngine({ platform: 'darwin', exists: () => false }), undefined);
  assert.equal(detectSystemEngine({ platform: 'linux', which: have('spd-say', 'espeak-ng') })?.engine, 'spd-say');
  assert.equal(detectSystemEngine({ platform: 'linux', which: have('espeak-ng', 'espeak') })?.engine, 'espeak-ng');
  assert.equal(detectSystemEngine({ platform: 'linux', which: have('espeak') })?.engine, 'espeak');
  assert.equal(detectSystemEngine({ platform: 'linux', which: have() }), undefined);
  assert.deepEqual(detectSystemEngine({ platform: 'win32' }), { engine: 'sapi', file: 'powershell.exe' });
  assert.equal(detectSystemEngine({ platform: 'freebsd', which: have('espeak-ng') }), undefined);
  assert.equal(systemVoiceAvailable({ platform: 'linux', which: have('espeak-ng') }), true);
  assert.equal(systemVoiceAvailable({ platform: 'linux', which: have() }), false);
  assert.equal(systemVoiceAvailable({ platform: 'win32' }), true);
  assert.equal(systemVoiceAvailable({ platform: 'darwin', exists: () => true }), true);
});

test('exact argv per engine; the text is never in argv', () => {
  assert.deepEqual(buildSystemCommand({ engine: 'say', file: '/usr/bin/say', voice: 'Paulina', speed: 1 }), { file: '/usr/bin/say', args: ['-v', 'Paulina', '-r', '185', '-f', '-'] });
  assert.deepEqual(buildSystemCommand({ engine: 'spd-say', file: '/usr/bin/spd-say', voice: SYSTEM_DEFAULT_VOICE, speed: 1 }), { file: '/usr/bin/spd-say', args: ['-w', '-l', 'es', '-r', '0', '-e'] });
  assert.deepEqual(buildSystemCommand({ engine: 'spd-say', file: '/usr/bin/spd-say', voice: 'Spanish Latin', speed: 1.5 }).args, ['-w', '-l', 'es', '-y', 'Spanish Latin', '-r', '50', '-e']);
  assert.deepEqual(buildSystemCommand({ engine: 'espeak-ng', file: '/usr/bin/espeak-ng', voice: 'es', speed: 1 }), { file: '/usr/bin/espeak-ng', args: ['-v', 'es', '-s', '175', '--stdin'] });
  assert.deepEqual(buildSystemCommand({ engine: 'espeak', file: '/usr/bin/espeak', voice: 'es-419', speed: 2 }).args, ['-v', 'es-419', '-s', '350', '--stdin']);
  const win = buildSystemCommand({ engine: 'sapi', file: 'powershell.exe', voice: 'Microsoft Sabina Desktop', speed: 1.5 });
  assert.deepEqual(win.args, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SPEAK_SCRIPT]);
  assert.deepEqual(win.env, { GENTLE_SPEAK_VOICE: 'Microsoft Sabina Desktop', GENTLE_SPEAK_RATE: '5' });
  assert.equal(buildSystemCommand({ engine: 'sapi', file: 'powershell.exe', voice: SYSTEM_DEFAULT_VOICE, speed: 1 }).env?.GENTLE_SPEAK_VOICE, '');
  assert.equal(/Hola/.test(POWERSHELL_SPEAK_SCRIPT), false);
  assert.match(POWERSHELL_SPEAK_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(POWERSHELL_SPEAK_SCRIPT, /System\.Speech/);
  assert.match(POWERSHELL_SPEAK_SCRIPT, /SelectVoice/);
});

test('rate mapping per engine', () => {
  assert.deepEqual([0.5, 1, 1.25, 2].map(s => systemRate('say', s)), [93, 185, 231, 370]);
  assert.deepEqual([0.5, 1, 1.5, 2].map(s => systemRate('spd-say', s)), [-50, 0, 50, 100]);
  assert.deepEqual([0.5, 1, 2].map(s => systemRate('espeak-ng', s)), [88, 175, 350]);
  assert.deepEqual([0.5, 1, 1.5, 2].map(s => systemRate('sapi', s)), [-5, 0, 5, 10]);
  assert.equal(systemRate('spd-say', 9), 100);
  assert.equal(systemRate('sapi', 9), 10);
});

for (const [platform, which, expected] of [
  ['linux', have('spd-say', 'espeak-ng'), ['-w', '-l', 'es', '-r', '0', '-e']],
  ['linux', have('espeak-ng'), ['-v', 'es', '-s', '175', '--stdin']],
] as const) {
  test(`${platform} ${expected[0]}: text goes on stdin only, then stdin ends`, async () => {
    const f = fakeSpawn();
    const text = 'Hola; $(rm -rf ~) "mundo" -v x';
    const p = speakWithSystemVoice({ voice: SYSTEM_DEFAULT_VOICE, text, speed: 1, spawn: f.spawn, platform, which });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args, expected);
    assert.equal(f.calls[0].args.some(a => a.includes('mundo')), false);
    assert.equal(f.calls[0].stdin.join(''), text);
    assert.equal(f.calls[0].ended, true);
    f.calls[0].child.emit('exit', 0);
    assert.deepEqual(await p, { ok: true, message: 'Speech completed.' });
  });
}

test('windows: text on stdin, voice and rate by environment, fixed script', async () => {
  const f = fakeSpawn();
  const text = "Hola `$(calc) 'x' \"y\"";
  const p = speakWithSystemVoice({ voice: 'Microsoft Helena Desktop', text, speed: 1, spawn: f.spawn, platform: 'win32' });
  assert.equal(f.calls[0].file, 'powershell.exe');
  assert.deepEqual(f.calls[0].args, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SPEAK_SCRIPT]);
  assert.equal(f.calls[0].args.join(' ').includes('calc'), false);
  assert.equal(f.calls[0].stdin.join(''), text);
  assert.equal(f.calls[0].env?.GENTLE_SPEAK_VOICE, 'Microsoft Helena Desktop');
  f.calls[0].child.emit('exit', 0);
  assert.equal((await p).ok, true);
});

test('macOS keeps the say invocation through the new module', async () => {
  const f = fakeSpawn();
  const p = speakWithSystemVoice({ voice: 'Paulina', text: 'Hola', speed: 1, spawn: f.spawn, platform: 'darwin' });
  assert.equal(f.calls[0].file, '/usr/bin/say');
  assert.deepEqual(f.calls[0].args, ['-v', 'Paulina', '-r', '185', '-f', '-']);
  f.calls[0].child.emit('exit', 0);
  assert.equal((await p).ok, true);
  const bad = await speakWithSystemVoice({ voice: 'a/b', text: 'x', speed: 1, spawn: f.spawn, platform: 'darwin' });
  assert.deepEqual(bad, await speakWithSay({ voice: 'a/b', text: 'x', speed: 1, spawn: f.spawn }));
});

test('no engine, invalid voice names and a failing child never speak', async () => {
  const f = fakeSpawn();
  assert.equal((await speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, spawn: f.spawn, platform: 'linux', which: have() })).ok, false);
  for (const voice of ['a/b', 'x;y', 'a'.repeat(65)]) assert.equal((await speakWithSystemVoice({ voice, text: 'x', speed: 1, spawn: f.spawn, platform: 'linux', which: have('espeak-ng') })).ok, false);
  assert.equal(f.calls.length, 0);
  const g = fakeSpawn();
  const p = speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, spawn: g.spawn, platform: 'linux', which: have('espeak-ng') });
  g.calls[0].child.emit('exit', 1);
  assert.deepEqual(await p, { ok: false, message: 'System voice failed.' });
  assert.equal((await speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, spawn: () => { throw new Error('boom'); }, platform: 'win32' })).ok, false);
});

for (const platform of ['linux', 'win32'] as const) {
  test(`${platform}: abort kills the process; a pre-aborted signal never spawns`, async () => {
    const f = fakeSpawn();
    const c = new AbortController();
    const p = speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, signal: c.signal, spawn: f.spawn, platform, which: have('espeak-ng') });
    c.abort();
    assert.deepEqual(await p, { ok: false, message: 'Speech cancelled.', cancelled: true });
    assert.deepEqual(f.calls[0].killed, ['SIGTERM']);
    const pre = new AbortController(); pre.abort();
    const g = fakeSpawn();
    assert.equal((await speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, signal: pre.signal, spawn: g.spawn, platform, which: have('espeak-ng') })).cancelled, true);
    assert.equal(g.calls.length, 0);
  });
  test(`${platform}: the timeout kills the process`, async () => {
    const f = fakeSpawn();
    const out = await speakWithSystemVoice({ voice: 'es', text: 'x', speed: 1, spawn: f.spawn, platform, which: have('espeak-ng'), timeoutMs: 5 });
    assert.deepEqual(out, { ok: false, message: 'System voice timed out.' });
    assert.deepEqual(f.calls[0].killed, ['SIGTERM']);
  });
}

test('voice listing: espeak-ng table, spd-say table, PowerShell Name|Culture lines; only Spanish', () => {
  const espeak = [
    'Pty Language       Age/Gender VoiceName          File                 Other Languages',
    ' 5  en-gb          --/M      English_(Great_Britain) gmw/en',
    ' 5  es              --/M      spanish            europe/es',
    ' 5  es-419          --/M      spanish-latam      es-419',
    ' 5  fr-fr          --/M      french             roa/fr',
  ].join('\n');
  assert.deepEqual(parseSystemVoices('espeak-ng', espeak), [{ name: 'spanish', locale: 'es' }, { name: 'spanish-latam', locale: 'es-419' }]);
  assert.deepEqual(parseSystemVoices('espeak', espeak).length, 2);
  const spd = ['NAME                          LANGUAGE   VARIANT', 'Spanish (Latin America)       es-419     none', 'english                       en         none', 'spanish                       es         male1'].join('\n');
  assert.deepEqual(parseSystemVoices('spd-say', spd), [{ name: 'Spanish (Latin America)', locale: 'es-419' }, { name: 'spanish', locale: 'es' }]);
  const ps = 'Microsoft Helena Desktop|es-ES\r\nMicrosoft David Desktop|en-US\r\nMicrosoft Sabina Desktop|es-MX\r\n\r\nrubbish';
  assert.deepEqual(parseSystemVoices('sapi', ps), [{ name: 'Microsoft Helena Desktop', locale: 'es-ES' }, { name: 'Microsoft Sabina Desktop', locale: 'es-MX' }]);
  assert.deepEqual(parseSystemVoices('sapi', ''), []);
  assert.deepEqual(parseSystemVoices('say', 'Paulina             es_MX    # Hola'), [{ name: 'Paulina', locale: 'es_MX' }]);
});

test('listing runs the engine list command and returns [] on failure', async () => {
  const seen: Array<[string, string[]]> = [];
  const run = async (file: string, args: string[]) => { seen.push([file, args]); return 'Microsoft Sabina Desktop|es-MX'; };
  assert.equal((await listSystemVoices({ platform: 'win32', run })).length, 1);
  assert.deepEqual(seen[0], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LIST_SCRIPT]]);
  await listSystemVoices({ platform: 'linux', which: have('espeak-ng'), run });
  assert.deepEqual(seen[1], ['/usr/bin/espeak-ng', ['--voices=es']]);
  await listSystemVoices({ platform: 'linux', which: have('spd-say', 'espeak-ng'), run });
  assert.equal(seen[2][0], '/usr/bin/spd-say');
  assert.deepEqual(await listSystemVoices({ platform: 'linux', which: have('espeak-ng'), run: async () => { throw new Error('x'); } }), []);
  assert.deepEqual(await listSystemVoices({ platform: 'linux', which: have(), run }), []);
});

test('the PowerShell scripts are valid PowerShell with no double quotes', { skip: spawnSync('pwsh', ['-v']).error !== undefined }, () => {
  for (const script of [POWERSHELL_SPEAK_SCRIPT, POWERSHELL_LIST_SCRIPT]) {
    assert.equal(script.includes('"'), false);
    const out = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:GS_SCRIPT,[ref]$null,[ref]$e);$e.Count'], { env: { ...process.env, GS_SCRIPT: script }, encoding: 'utf8' });
    assert.equal(out.stdout.trim(), '0', out.stderr);
  }
});

test('Spanish auto-pick per platform', () => {
  const v = (name: string, locale: string) => ({ name, locale });
  assert.equal(pickSystemVoice([v('Flo', 'es_ES'), v('Paulina', 'es_MX')], null, 'darwin'), 'Paulina');
  const linux = [v('spanish', 'es'), v('spanish-latam', 'es-419'), v('catalan', 'es-xx')];
  assert.equal(pickSystemVoice(linux, null, 'linux'), 'spanish-latam');
  assert.equal(pickSystemVoice(linux, 'spanish', 'linux'), 'spanish');
  assert.equal(pickSystemVoice(linux, 'gone', 'linux'), 'spanish-latam');
  assert.equal(pickSystemVoice([v('spanish', 'es')], null, 'linux'), 'spanish');
  const win = [v('Microsoft Helena Desktop', 'es-ES'), v('Microsoft Pablo', 'es-ES'), v('Microsoft Sabina Desktop', 'es-MX'), v('Other', 'es-AR')];
  assert.equal(pickSystemVoice(win, null, 'win32'), 'Microsoft Sabina Desktop');
  assert.equal(pickSystemVoice(win.filter(x => !/Sabina/.test(x.name)), null, 'win32'), 'Microsoft Helena Desktop');
  assert.equal(pickSystemVoice([v('Microsoft Pablo', 'es-ES'), v('Other', 'es-AR')], null, 'win32'), 'Microsoft Pablo');
  assert.equal(pickSystemVoice([], null, 'win32'), undefined);
  // Linux always has a usable default (`es`); Windows and macOS need an installed voice.
  assert.equal(resolveSystemVoice([], null, 'linux'), SYSTEM_DEFAULT_VOICE);
  assert.equal(resolveSystemVoice([], null, 'win32'), undefined);
  assert.equal(resolveSystemVoice([], null, 'darwin'), undefined);
});

test('label per platform', () => {
  assert.equal(systemVoiceLabel('darwin'), 'Mac');
  assert.equal(systemVoiceLabel('linux'), 'Sistema');
  assert.equal(systemVoiceLabel('win32'), 'Sistema');
});

test('old settings files load unchanged on every platform (mac id, macVoice, macFallback)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speak-sysvoice-'));
  try {
    writeFileSync(join(dir, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice: 'mac', macVoice: 'Microsoft Sabina Desktop', macFallback: false }));
    const s = readSpeakSettings(dir);
    assert.equal(s.voice, 'mac'); assert.equal(s.macVoice, 'Microsoft Sabina Desktop'); assert.equal(s.macFallback, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor line and hint per platform', () => {
  const voices = [{ name: 'spanish', locale: 'es' }];
  assert.deepEqual(systemVoiceStatus({ platform: 'darwin', exists: () => true }, [{ name: 'Paulina', locale: 'es_MX' }], null), { available: true, detail: 'say: 1 voz/voces en español (elegida: Paulina)' });
  assert.match(systemVoiceStatus({ platform: 'linux', which: have('spd-say') }, voices, null).detail, /^spd-say: 1 voz/);
  assert.match(systemVoiceStatus({ platform: 'linux', which: have('espeak-ng') }, voices, null).detail, /^espeak-ng: 1 voz.*elegida: spanish/);
  assert.match(systemVoiceStatus({ platform: 'linux', which: have('espeak-ng') }, [], null).detail, /^espeak-ng: sin voces listadas; usa «es»/);
  assert.equal(systemVoiceStatus({ platform: 'linux', which: have('espeak-ng') }, [], null).available, true);
  assert.match(systemVoiceStatus({ platform: 'win32' }, [{ name: 'Microsoft Sabina Desktop', locale: 'es-MX' }], null).detail, /^SAPI: 1 voz.*Sabina/);
  assert.equal(systemVoiceStatus({ platform: 'win32' }, [], null).available, false);
  const missing = systemVoiceStatus({ platform: 'linux', which: have() }, [], null);
  assert.equal(missing.available, false);
  assert.match(missing.detail, /spd-say.*espeak-ng/);
  assert.equal(systemVoiceHint('linux'), 'sudo apt install speech-dispatcher espeak-ng (o el gestor de paquetes de tu distribución)');
  assert.match(systemVoiceHint('win32'), /integrada en Windows/);
  assert.match(systemVoiceHint('darwin'), /Contenido hablado/);
});
