import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { QWEN_MODEL_ID, QWEN_PYTHON_FLAGS, QWEN_VOICES, type QwenVoice } from './speak-voices.ts';

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
