import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { qwenPythonEnv } from './speak-qwen.ts';
import { CUSTOM_ID_PATTERN, CUSTOM_VOICE_PREFIX, QWEN_PYTHON_FLAGS } from './speak-voices.ts';

// S14 (T42): custom voices live in `<sharedHome>/voices/custom/<id>/{voice.json,reference.wav}`. They stay local, are verified by sha256 on every read,
// are created by writing a temp dir and renaming it, and are never uploaded. Speech clones `reference.wav` with the Base model like the built-in Qwen voices.
export type CustomVoiceSource = 'designed' | 'recorded';
/** The catalog entry of one verified custom voice: `id` is the setting value (`custom:<id>`), `ref` the verified reference WAV. */
export interface CustomVoice { id: string; engine: 'qwen3'; custom: true; label: string; ref: string; transcript: string; source: CustomVoiceSource }
export interface SkippedCustomVoice { id: string; reason: string }
export interface CustomVoiceList { voices: CustomVoice[]; skipped: SkippedCustomVoice[] }
export interface CustomVoiceMeta { id: string; label: string; transcript: string; description?: string; language: string; source: CustomVoiceSource; created: string; sha256: string }

export const CUSTOM_LABEL_MAX = 40;
export const CUSTOM_TRANSCRIPT_MAX = 500;
export const CUSTOM_WAV_MIN_SECONDS = 3;
export const CUSTOM_WAV_MAX_SECONDS = 30;
/** A reference is at most 30 s of PCM16 mono; this bounds what is ever read into memory (a 30 s mono 192 kHz file is about 11.5 MB). */
export const CUSTOM_WAV_MAX_BYTES = 16 * 1024 * 1024;
const VOICE_JSON_MAX = 16 * 1024;
const REFERENCE = 'reference.wav';
const VOICE_JSON = 'voice.json';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const control = /[\p{Cc}\u2028\u2029]/u;

export const customVoicesDir = (home: string) => join(home, 'voices', 'custom');

// ---- WAV ----------------------------------------------------------------------------------------------------------------------------
export interface WavInfo { channels: number; rate: number; bits: number; seconds: number }
/** Parses the header of a PCM16 mono WAV and enforces 3-30 s; throws an Error whose message says why not. */
export function inspectWav(data: Buffer, { maxSeconds = CUSTOM_WAV_MAX_SECONDS }: { maxSeconds?: number } = {}): WavInfo {
  if (data.length < 44 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a valid WAV file');
  let at = 12, fmt: { format: number; channels: number; rate: number; bits: number } | undefined, bytes: number | undefined;
  while (at + 8 <= data.length) {
    const id = data.toString('latin1', at, at + 4), size = data.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= data.length) {
      let format = data.readUInt16LE(body);
      if (format === 0xfffe && size >= 40 && body + 26 <= data.length) format = data.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format decides
      fmt = { format, channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) };
    } else if (id === 'data') { bytes = Math.min(size, data.length - body); break; }
    at = body + size + (size % 2);
  }
  if (!fmt || bytes === undefined) throw new Error('Not a valid WAV file');
  if (fmt.format !== 1) throw new Error('The WAV is not PCM');
  if (fmt.bits !== 16) throw new Error('The WAV must be 16-bit');
  if (fmt.channels !== 1) throw new Error('The WAV must be mono');
  if (fmt.rate < 8000 || fmt.rate > 192000) throw new Error('The WAV sample rate is not supported');
  const seconds = bytes / (fmt.rate * 2);
  if (seconds < CUSTOM_WAV_MIN_SECONDS) throw new Error(`The WAV is too short (minimum ${CUSTOM_WAV_MIN_SECONDS} s)`);
  if (seconds > maxSeconds) throw new Error(`The WAV is too long (maximum ${CUSTOM_WAV_MAX_SECONDS} s)`);
  return { channels: fmt.channels, rate: fmt.rate, bits: fmt.bits, seconds };
}

// ---- validation ---------------------------------------------------------------------------------------------------------------------
const validId = (id: unknown): id is string => typeof id === 'string' && CUSTOM_ID_PATTERN.test(id);
const validLabel = (label: unknown): label is string => typeof label === 'string' && label.trim().length >= 1 && label.length <= CUSTOM_LABEL_MAX && !control.test(label);
const validTranscript = (text: unknown): text is string => typeof text === 'string' && text.trim().length >= 1 && text.length <= CUSTOM_TRANSCRIPT_MAX && !control.test(text);

/** The reason a parsed voice.json is not a valid entry for directory `name`, else undefined. */
function invalidMeta(meta: any, name: string): string | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return 'voice.json is not an object';
  if (!validId(meta.id) || meta.id !== name) return 'id does not match the directory';
  if (!validLabel(meta.label)) return 'invalid label';
  if (!validTranscript(meta.transcript)) return 'invalid transcript';
  if (meta.source !== 'designed' && meta.source !== 'recorded') return 'invalid source';
  if (meta.description !== undefined && (typeof meta.description !== 'string' || meta.description.length > 1000)) return 'invalid description';
  if (typeof meta.language !== 'string' || !/^[a-z]{2,3}$/.test(meta.language)) return 'invalid language';
  if (typeof meta.created !== 'string' || Number.isNaN(Date.parse(meta.created))) return 'invalid created';
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) return 'invalid sha256';
  return undefined;
}

type Read = { voice: CustomVoice } | { reason: string };
async function readEntry(home: string, name: string): Promise<Read> {
  if (!validId(name)) return { reason: 'invalid id' };
  const dir = join(customVoicesDir(home), name);
  try {
    if (!(await lstat(dir)).isDirectory()) return { reason: 'not a directory' };
    const wavStat = await lstat(join(dir, REFERENCE)).catch(() => undefined);
    if (!wavStat) return { reason: 'reference.wav is missing' };
    if (!wavStat.isFile() || wavStat.size > CUSTOM_WAV_MAX_BYTES) return { reason: 'reference.wav is not a regular file of a valid size' };
    const jsonStat = await lstat(join(dir, VOICE_JSON)).catch(() => undefined);
    if (!jsonStat) return { reason: 'voice.json is missing' };
    if (!jsonStat.isFile() || jsonStat.size > VOICE_JSON_MAX) return { reason: 'voice.json is not a regular file of a valid size' };
    let meta: any;
    try { meta = JSON.parse(await readFile(join(dir, VOICE_JSON), 'utf8')); } catch { return { reason: 'voice.json is malformed' }; }
    const invalid = invalidMeta(meta, name);
    if (invalid) return { reason: invalid };
    if (sha256(await readFile(join(dir, REFERENCE))) !== meta.sha256) return { reason: 'sha256 mismatch' };
    return { voice: { id: `${CUSTOM_VOICE_PREFIX}${name}`, engine: 'qwen3', custom: true, label: `Propia · ${meta.label.trim()}`, ref: join(dir, REFERENCE), transcript: meta.transcript, source: meta.source } };
  } catch { return { reason: 'unreadable' }; }
}

/** Lists the valid custom voices (sorted by id); every invalid entry is reported in `skipped` and never offered. Hidden stage and trash dirs are ignored. */
export async function listCustomVoices(home: string): Promise<CustomVoiceList> {
  let names: string[];
  try { names = (await readdir(customVoicesDir(home))).filter(name => !name.startsWith('.')).sort(); } catch { return { voices: [], skipped: [] }; }
  const out: CustomVoiceList = { voices: [], skipped: [] };
  for (const name of names) {
    const read = await readEntry(home, name);
    if ('voice' in read) out.voices.push(read.voice); else out.skipped.push({ id: name, reason: read.reason });
  }
  return out;
}

/** One verified custom voice by its bare id (`mi-voz`, not `custom:mi-voz`), or undefined when it is missing or invalid. Used at speech time. */
export async function readCustomVoice(home: string, id: string): Promise<CustomVoice | undefined> {
  const read = await readEntry(home, id);
  return 'voice' in read ? read.voice : undefined;
}

/** Catalog entries keyed `custom:<id>`, ready to merge after the built-in catalog. */
export function customCatalog(voices: readonly CustomVoice[]): Record<string, CustomVoice> {
  return Object.fromEntries(voices.map(voice => [voice.id, voice]));
}

/** A valid, unused id from a label: accents stripped, lowercase, `-` separated, at most 32 chars; `voz` when nothing usable remains. */
export function slugifyVoiceId(label: string, taken: ReadonlySet<string>): string {
  const slug = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'voz';
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`, candidate = `${slug.slice(0, 32 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---- create / delete ----------------------------------------------------------------------------------------------------------------
export interface CreateCustomVoiceOptions {
  home: string; id: string; label: string; transcript: string; source: CustomVoiceSource; wav: Buffer;
  language?: string; description?: string; now?: Date;
  /** T45: only the migration of the old built-in voices sets it: two of them are 35-36 s, over the 30 s import limit. The size bound still applies. */
  allowLong?: boolean;
}
/** Validates everything, writes a temp dir next to the target and renames it into place: an entry is whole or absent. An existing id is refused. */
export async function createCustomVoice(options: CreateCustomVoiceOptions): Promise<CustomVoice> {
  const { home, id, transcript, source, wav } = options;
  if (!validId(id)) throw new Error('Invalid id');
  if (!validLabel(options.label)) throw new Error(`Invalid label (1-${CUSTOM_LABEL_MAX} characters, no control characters)`);
  if (!validTranscript(transcript)) throw new Error(`Invalid transcript (1-${CUSTOM_TRANSCRIPT_MAX} characters)`);
  if (source !== 'designed' && source !== 'recorded') throw new Error('Invalid source');
  const language = options.language ?? 'es';
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error('Invalid language');
  if (options.description !== undefined && (typeof options.description !== 'string' || options.description.length > 1000)) throw new Error('Invalid description');
  if (wav.length > CUSTOM_WAV_MAX_BYTES) throw new Error('The WAV is too long (file too large)');
  inspectWav(wav, options.allowLong ? { maxSeconds: Infinity } : {});
  const root = customVoicesDir(home), final = join(root, id), stage = join(root, `.stage-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await lstat(final).then(() => true, () => false)) throw new Error(`A custom voice with id "${id}" already exists`);
  const meta: CustomVoiceMeta = { id, label: options.label.trim(), transcript: transcript.trim(), ...(options.description !== undefined ? { description: options.description } : {}), language, source, created: (options.now ?? new Date()).toISOString(), sha256: sha256(wav) };
  try {
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, REFERENCE), wav, { flag: 'wx', mode: 0o600 });
    await writeFile(join(stage, VOICE_JSON), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(stage, final);
  } finally { await rm(stage, { recursive: true, force: true }); }
  const created = await readCustomVoice(home, id);
  if (!created) throw new Error('The custom voice could not be verified after writing');
  return created;
}

/** Deletes one entry by bare id. A symlinked entry loses only the link. Returns false when it did not exist; an invalid id throws and touches nothing. */
export async function deleteCustomVoice(home: string, id: string): Promise<boolean> {
  if (!validId(id)) throw new Error('Invalid id');
  const target = join(customVoicesDir(home), id);
  const stat = await lstat(target).catch(() => undefined);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) { await unlink(target); return true; }
  const trash = join(customVoicesDir(home), `.del-${randomUUID()}`);
  await rename(target, trash); // gone from the list at once; the removal below can fail without leaving a half-listed entry
  await rm(trash, { recursive: true, force: true });
  return true;
}

// ---- the design/import script -------------------------------------------------------------------------------------------------------
/** Runs one Python process and returns its exit code and (bounded) stdout; injected in tests. */
export type PythonRun = (python: string, args: string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<{ code: number | null; stdout: string }>;
const STDOUT_MAX = 64 * 1024;
export const defaultPythonRun: PythonRun = (python, args, { env, signal, timeoutMs }) => new Promise(resolve => {
  let stdout = '', done = false;
  let child: ReturnType<typeof spawn>;
  const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, stdout }); };
  const abort = () => { try { child?.kill(); } catch { /* gone */ } finish(null); };
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  try { child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], env }); } catch { finish(null); return; }
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { if (stdout.length < STDOUT_MAX) stdout += chunk; });
  child.stderr?.on('data', () => { /* logs stay on stderr; drained so the pipe never blocks */ });
  child.on('error', () => finish(null));
  child.on('close', code => finish(code));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

export type VoiceScriptOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };
const cleanMessage = (text: unknown) => (typeof text === 'string' ? text.replace(/[\p{Cc}]/gu, ' ').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '');

/** Runs `scripts/speak-design-voice.py <mode> ...` with the same interpreter flags as the worker and reads its single JSON result line. */
export async function runVoiceScript(options: { python: string; script: string; args: string[]; run?: PythonRun; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<VoiceScriptOutcome> {
  const run = options.run ?? defaultPythonRun;
  let outcome: { code: number | null; stdout: string };
  try { outcome = await run(options.python, [...QWEN_PYTHON_FLAGS, options.script, ...options.args], { env: options.env ?? qwenPythonEnv(), signal: options.signal, timeoutMs: options.timeoutMs ?? 15 * 60_000 }); }
  catch { return { ok: false, code: 'spawn', message: 'The Python process could not start' }; }
  if (options.signal?.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled' };
  const line = outcome.stdout.split('\n').map(text => text.trim()).filter(Boolean).at(-1);
  let parsed: any;
  try { parsed = line ? JSON.parse(line) : undefined; } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && parsed.ok === true && outcome.code === 0) return { ok: true, result: parsed };
  if (parsed && typeof parsed === 'object' && parsed.ok === false) return { ok: false, code: typeof parsed.code === 'string' ? cleanMessage(parsed.code).slice(0, 40) : 'failed', message: cleanMessage(parsed.message) || 'The script failed' };
  return { ok: false, code: outcome.code === null ? 'spawn' : 'failed', message: 'The script did not produce a result' };
}
