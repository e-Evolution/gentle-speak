import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { QWEN_DESIGN_MODEL_ID, QWEN_MODEL_ID, QWEN_PYTHON_FLAGS, QWEN_VOICES, type QwenVoice } from './speak-voices.ts';
import { qwenPythonEnv } from './speak-qwen.ts';

export const QWEN_VOICES_SCHEMA = 'gentle-speak.qwen-voices/v1';
export type QwenCatalog = Readonly<Record<string, QwenVoice>>;
export type QwenRun = (command: string, args: string[]) => Promise<{ code: number }>;
export type QwenVoiceState = 'installed' | 'missing' | 'invalid';
export interface QwenVoicesStatus { manifest: 'valid' | 'missing' | 'invalid'; voices: Record<string, QwenVoiceState> }
export interface InstallQwenVoicesOptions { sourceDir: string; home: string; python: string; catalog?: QwenCatalog; run?: QwenRun }

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const voicesDir = (home: string) => join(home, 'voices', 'qwen3');
const defaultRun: QwenRun = (command, args) => new Promise(resolve => {
  execFile(command, args, { timeout: 60_000 }, error => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }));
});
const safeName = (file: string) => file === basename(file) && file !== '' && file !== '.' && file !== '..';
const read = async (path: string): Promise<Buffer | undefined> => {
  try { return (await lstat(path)).isFile() ? await readFile(path) : Buffer.alloc(0, 1); } catch { return undefined; }
};
const matches = (data: Buffer | undefined, voice: QwenVoice) => !!data && data.length === voice.bytes && sha256(data) === voice.sha256;

export async function qwenVoicesStatus(home: string, catalog: QwenCatalog = QWEN_VOICES): Promise<QwenVoicesStatus> {
  const dir = voicesDir(home);
  const voices: Record<string, QwenVoiceState> = {};
  for (const [id, voice] of Object.entries(catalog)) {
    if (!safeName(voice.file)) { voices[id] = 'invalid'; continue; }
    const data = await read(join(dir, voice.file));
    voices[id] = data === undefined ? 'missing' : matches(data, voice) ? 'installed' : 'invalid';
  }
  let raw: string | undefined;
  try { raw = await readFile(join(dir, 'manifest.json'), 'utf8'); } catch { /* missing */ }
  if (raw === undefined) return { manifest: 'missing', voices };
  try {
    const manifest = JSON.parse(raw);
    const entries = manifest?.voices;
    const valid = manifest?.schema === QWEN_VOICES_SCHEMA && typeof manifest.python === 'string' && manifest.model === QWEN_MODEL_ID
      && entries && typeof entries === 'object'
      && Object.entries(catalog).every(([id, v]) => {
        const e = entries[id];
        return e && e.file === v.file && e.sha256 === v.sha256 && e.bytes === v.bytes && e.transcript === v.transcript;
      });
    return { manifest: valid ? 'valid' : 'invalid', voices };
  } catch { return { manifest: 'invalid', voices }; }
}

/** Copy, verify and atomically publish the catalog WAVs plus a manifest. Validates everything before writing anything. */
export async function installQwenVoices({ sourceDir, home, python, catalog = QWEN_VOICES, run = defaultRun }: InstallQwenVoicesOptions): Promise<{ path: string; installed: string[] }> {
  if ((await run(python, [...QWEN_PYTHON_FLAGS, '-c', 'from mlx_audio.tts.utils import load_model'])).code !== 0) throw new Error(`Python check failed: ${python} cannot load mlx_audio.tts.utils`);
  const dir = voicesDir(home);
  const pending: Array<{ id: string; voice: QwenVoice; data: Buffer }> = [];
  for (const [id, voice] of Object.entries(catalog)) {
    if (!safeName(voice.file)) throw new Error(`Invalid file name for ${id}`);
    const data = await read(join(sourceDir, voice.file));
    if (data === undefined) throw new Error(`Source file for ${id} is missing: ${voice.file}`);
    if (data.length !== voice.bytes) throw new Error(`Size mismatch for ${id} (${voice.file}): expected ${voice.bytes}, got ${data.length}`);
    if (sha256(data) !== voice.sha256) throw new Error(`sha256 mismatch for ${id} (${voice.file})`);
    const existing = await read(join(dir, voice.file));
    if (existing !== undefined && !matches(existing, voice)) throw new Error(`Existing ${voice.file} differs from the catalog (invalid); not overwriting`);
    if (existing === undefined) pending.push({ id, voice, data });
  }
  await mkdir(dir, { recursive: true });
  const publish = async (name: string, data: Buffer | string) => {
    const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, join(dir, name)); }
    finally { await rm(temporary, { force: true }); }
  };
  for (const { voice, data } of pending) await publish(voice.file, data);
  const voices = Object.fromEntries(Object.entries(catalog).map(([id, v]) => [id, { file: v.file, sha256: v.sha256, bytes: v.bytes, transcript: v.transcript }]));
  await publish('manifest.json', `${JSON.stringify({ schema: QWEN_VOICES_SCHEMA, python, model: QWEN_MODEL_ID, voices }, null, 2)}\n`);
  return { path: dir, installed: pending.map(p => p.id) };
}

// ---- S14 (T42): the VoiceDesign model, a separate, explicit, confirmed download (never automatic; used only to design a voice) ----------
export type DesignModelState = 'installed' | 'missing';
/** Measured 2026-11-11 on the local Hugging Face cache snapshot of the repo (`du -skL`: 4 414 288 KiB); used only when the API cannot be asked. */
export const QWEN_DESIGN_APPROX_BYTES = 4_414_288 * 1024;
const DESIGN_REPO_DIR = `models--${QWEN_DESIGN_MODEL_ID.replace('/', '--')}`;

/** `<HF_HOME>`: a user-set `HF_HOME`, else `<real home>/.cache/huggingface`; the same rule as the Qwen child's environment. */
export const hfHomeOf = (env: NodeJS.ProcessEnv, home: string): string => qwenPythonEnv(env, home).HF_HOME as string;

/** `installed` only when a cached snapshot has config.json, a speech_tokenizer dir and at least one non-empty safetensors file that resolves (a dangling link is an interrupted download). */
export async function designModelStatus(hfHome: string): Promise<DesignModelState> {
  const snapshots = join(hfHome, 'hub', DESIGN_REPO_DIR, 'snapshots');
  let names: string[];
  try { names = await readdir(snapshots); } catch { return 'missing'; }
  for (const name of names) {
    const dir = join(snapshots, name);
    try {
      if (!(await stat(join(dir, 'config.json'))).isFile() || !(await stat(join(dir, 'speech_tokenizer'))).isDirectory()) continue;
      for (const file of await readdir(dir)) if (file.endsWith('.safetensors') && (await stat(join(dir, file)).catch(() => undefined))?.size) return 'installed';
    } catch { /* incomplete snapshot */ }
  }
  return 'missing';
}

/** Total bytes of the repo from the public Hugging Face API (metadata only, nothing is downloaded); undefined when it cannot be read. */
export async function designModelSize(fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 5000): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`https://huggingface.co/api/models/${QWEN_DESIGN_MODEL_ID}?blobs=true`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body: any = await response.json();
    const total = (Array.isArray(body?.siblings) ? body.siblings : []).reduce((sum: number, file: any) => sum + (typeof file?.size === 'number' && file.size > 0 ? file.size : 0), 0);
    return total > 0 ? total : undefined;
  } catch { return undefined; }
}

/** The size as shown in the confirmation, always with its source. */
export function describeDesignModelSize(bytes: number | undefined): string {
  return bytes === undefined
    ? `aprox. ${(QWEN_DESIGN_APPROX_BYTES / 1e9).toFixed(1)} GB (medido en la caché local de Hugging Face el 2026-11-11; no pude consultar la API)`
    : `${(bytes / 1e9).toFixed(1)} GB (según la API de Hugging Face)`;
}

export type DesignRun = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ code: number }>;
const defaultDesignRun: DesignRun = (command, args, { env, signal }) => new Promise(resolve => {
  execFile(command, args, { env, signal, timeout: 60 * 60_000, maxBuffer: 1024 * 1024 }, error => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }));
});

/** Downloads the VoiceDesign model into the Hugging Face cache with the worker's interpreter; the one online step (`HF_HUB_OFFLINE` unset). Requires `confirmed: true`. */
export async function installDesignModel({ python, hfHome, home, confirmed, signal, run = defaultDesignRun }: { python: string; hfHome: string; home: string; confirmed: boolean; signal?: AbortSignal; run?: DesignRun }): Promise<void> {
  if (confirmed !== true) throw new Error('Explicit caller confirmation is required.');
  const env = { ...qwenPythonEnv(process.env, home), HF_HOME: hfHome };
  delete env.HF_HUB_OFFLINE;
  const code = `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(QWEN_DESIGN_MODEL_ID)})`;
  if ((await run(python, [...QWEN_PYTHON_FLAGS, '-c', code], { env, signal })).code !== 0) throw new Error('Download failed: the VoiceDesign model could not be fetched');
  if (await designModelStatus(hfHome) !== 'installed') throw new Error('Download did not complete: the VoiceDesign model is not installed; could not verify it');
}
