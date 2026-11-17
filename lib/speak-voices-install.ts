/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { QWEN_DESIGN_MODEL_ID, QWEN_MODEL_ID, QWEN_PYTHON_FLAGS } from './speak-voices.ts';
import { qwenPythonEnv, readQwenPython } from './speak-qwen.ts';
import { withPrivateCwd } from './speak-qwen-service.ts';
import { SPEAK_SETTINGS_FILE, parseSpeakSettingsFile } from './speak-settings.ts';
import { createCustomVoice, listCustomVoices, slugifyVoiceId } from './speak-custom-voices.ts';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const safeName = (file: string) => file === basename(file) && file !== '' && file !== '.' && file !== '..';

// ---- the interpreter record -------------------------------------------------------------------------------------------------------
// Custom voices need only a Python with mlx-audio and the Base model, not the old built-in voices manifest. The interpreter is recorded in
// `<sharedHome>/python.json` (the setup writes it for its own environment). The old `voices/qwen3/manifest.json` python is still read when there is no record.
export const PYTHON_RECORD_FILE = 'python.json';
export const PYTHON_RECORD_SCHEMA = 'gentle-speak.python/v1';
/** The Qwen interpreter: `<home>/python.json` when it is a valid record with an absolute path, else the python of the old manifest, else undefined. */
export function resolveQwenPython(home: string): string | undefined {
  try {
    const record = JSON.parse(readFileSync(join(home, PYTHON_RECORD_FILE), 'utf8'));
    if (record?.schema === PYTHON_RECORD_SCHEMA && typeof record.python === 'string' && isAbsolute(record.python)) return record.python;
  } catch { /* no record: fall through */ }
  return readQwenPython(home);
}

// ---- one-time conversion of the old built-in Qwen voices -------------------------------------------------------------------
/** The first releases bundled 7 personal reference WAVs. They are no longer public; this table only recognizes an existing install (no WAV is shipped). */
export interface LegacyQwenVoice { name: string; label: string; file: string; transcript: string; sha256: string; bytes: number }
export const QWEN_VOICES_SCHEMA = 'gentle-speak.qwen-voices/v1';
export const LEGACY_QWEN_VOICES: Readonly<Record<string, LegacyQwenVoice>> = {
  "qwen-suave": { name: "suave", label: "Suave", file: "f3-suave.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escúchame un segundo y me dices si te convence, ¿va?", sha256: "d2bddd57ef9268065b53b7c42a6d1051a438e00c1c519bb9cac275699ca3a48a", bytes: 1080130 },
  "qwen-brisa": { name: "brisa", label: "Brisa", file: "f2-brisa.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escúchame un segundo y me dices si te convence, ¿va?", sha256: "06c7fcebab6715a5bcbb9c60b50da4d2c2d69c82cba33d0abeaaadd3dfb586f0", bytes: 1080694 },
  "qwen-coqueta": { name: "coqueta", label: "Coqueta", file: "qwen3-vd-v3h-x.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escuchame un segundo y me decis si te convence, ¿va?", sha256: "89dca671b7d0d49b0a6c3fa0e7abccced663c9a4ce0ecb3754aeb4e91806a745", bytes: 1662764 },
  "qwen-maestra": { name: "maestra", label: "Maestra", file: "qwen3-vd-v3h-t1.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escuchame un segundo y me decis si te convence, ¿va?", sha256: "c4610abc3b8acabf631d6ac5eeb3f9bb2256036619af3286360c39cb127e348e", bytes: 1731884 },
  "qwen-intima": { name: "intima", label: "Íntima", file: "qwen3-chain-l3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "9a4523fa9358accfb20bafc8c04d42c4b00a0356fe41e18204dce6e4bd27e327", bytes: 364844 },
  "qwen-serena": { name: "serena", label: "Serena", file: "qwen3-vd-v3h-t1-frio3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "79518f55c129eba1df27226b99ad1f136a7ef3f14dc56e162869c1a934db4219", bytes: 430124 },
  "qwen-viva": { name: "viva", label: "Viva", file: "qwen3-vd-v3h-t1-s7-linea3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "2461137825aab2f80d88bcd3787e88e3a4e71d19060cb70738ed8172c8070cbf", bytes: 564524 },
};

export const MIGRATION_MARKER_FILE = 'qwen-migrated.json';
export const MIGRATION_MARKER_SCHEMA = 'gentle-speak.qwen-migration/v1';
export interface MigrationOutcome {
  /** `none`: nothing to migrate (no valid old manifest, or no listed voice); `already`: recorded earlier; `migrated`: this run converted or skipped voices. */
  status: 'none' | 'already' | 'migrated';
  /** Custom voices created from an old one. */
  created: Array<{ legacyId: string; id: string; label: string }>;
  /** Old voices whose audio already existed as a custom voice (same sha256): reused, not duplicated. */
  reused: Array<{ legacyId: string; id: string }>;
  /** Old voices not converted (WAV missing or different, manifest entry different, create failed), with a short reason. */
  skipped: Array<{ legacyId: string; reason: string }>;
  /** Settings files whose `voice` was changed. */
  mapped: string[];
}
export interface MigrateOptions { home: string; settingsDirs: readonly string[]; table?: Readonly<Record<string, LegacyQwenVoice>>; now?: Date }

const readJson = async (path: string): Promise<any> => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } };
async function publishText(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
/** Changes only `voice` of a valid settings file (every other key kept, atomic write); false when the file is absent, malformed, or not on a migrated voice. */
async function mapSettingsFile(dir: string, mapping: ReadonlyMap<string, string>): Promise<string | undefined> {
  const path = join(dir, SPEAK_SETTINGS_FILE);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch { return undefined; }
  if (!parseSpeakSettingsFile(raw)) return undefined;
  const json = JSON.parse(raw), target = typeof json.voice === 'string' ? mapping.get(json.voice) : undefined;
  if (!target) return undefined;
  try { await publishText(path, `${JSON.stringify({ ...json, voice: target })}\n`); return path; } catch { return undefined; }
}

/**
 * Converts, once, an install that has the old built-in Qwen voices (`<home>/voices/qwen3/` with a valid manifest) into custom voices with the same label,
 * transcript and sha256, and maps `voice: qwen-<name>` to `custom:<name>` in every settings file given. The WAV is copied (never moved) with the custom-voice
 * atomic create; nothing is deleted. A voice whose WAV is missing or whose sha256 differs from the table is skipped. The result is recorded in
 * `<home>/qwen-migrated.json` so it never runs again.
 */
export async function migrateLegacyQwenVoices({ home, settingsDirs, table = LEGACY_QWEN_VOICES, now }: MigrateOptions): Promise<MigrationOutcome> {
  const outcome: MigrationOutcome = { status: 'none', created: [], reused: [], skipped: [], mapped: [] };
  if (await stat(join(home, MIGRATION_MARKER_FILE)).then(() => true, () => false)) return { ...outcome, status: 'already' };
  const oldDir = join(home, 'voices', 'qwen3');
  const manifest = await readJson(join(oldDir, 'manifest.json'));
  const entries = manifest?.voices;
  if (manifest?.schema !== QWEN_VOICES_SCHEMA || typeof manifest.python !== 'string' || manifest.model !== QWEN_MODEL_ID || entries === null || typeof entries !== 'object' || Array.isArray(entries)) return outcome;

  const existing = (await listCustomVoices(home)).voices;
  const taken = new Set<string>(await readdir(join(home, 'voices', 'custom')).catch(() => [] as string[]));
  const existingHashes = new Map<string, string>(); // sha256 of an existing custom voice's audio -> its id
  for (const voice of existing) { try { existingHashes.set(sha256(await readFile(voice.ref)), voice.id); } catch { /* unreadable: never a match */ } }

  const mapping = new Map<string, string>();
  for (const [legacyId, voice] of Object.entries(table)) {
    const entry = entries[legacyId];
    if (entry === undefined) continue;
    const skip = (reason: string) => { outcome.skipped.push({ legacyId, reason }); };
    if (!entry || entry.file !== voice.file || entry.sha256 !== voice.sha256 || entry.bytes !== voice.bytes) { skip('the manifest entry differs from the known voice'); continue; }
    if (!safeName(voice.file)) { skip('invalid file name'); continue; }
    const path = join(oldDir, voice.file);
    const info = await lstat(path).catch(() => undefined);
    if (!info) { skip(`${voice.file} is missing`); continue; }
    if (!info.isFile() || info.size !== voice.bytes) { skip(`${voice.file} is not the expected file`); continue; }
    let wav: Buffer;
    try { wav = await readFile(path); } catch { skip(`${voice.file} is unreadable`); continue; }
    if (sha256(wav) !== voice.sha256) { skip(`${voice.file} sha256 does not match`); continue; }
    const same = existingHashes.get(voice.sha256);
    if (same) { outcome.reused.push({ legacyId, id: same }); mapping.set(legacyId, same); continue; }
    const id = slugifyVoiceId(voice.name, taken);
    try {
      const created = await createCustomVoice({ home, id, label: voice.label, transcript: voice.transcript, source: 'designed', wav, language: 'es', now, allowLong: true });
      taken.add(id); existingHashes.set(voice.sha256, created.id);
      outcome.created.push({ legacyId, id: created.id, label: voice.label }); mapping.set(legacyId, created.id);
    } catch (error) { skip(`could not create the custom voice (${error instanceof Error ? error.message : 'error'})`); }
  }
  if (outcome.created.length + outcome.reused.length + outcome.skipped.length === 0) return outcome;

  for (const dir of new Set(settingsDirs)) { const path = await mapSettingsFile(dir, mapping); if (path) outcome.mapped.push(path); }
  outcome.status = 'migrated';
  await publishText(join(home, MIGRATION_MARKER_FILE), `${JSON.stringify({ schema: MIGRATION_MARKER_SCHEMA, at: (now ?? new Date()).toISOString(), created: outcome.created.map(c => c.id), reused: outcome.reused.map(r => r.id), skipped: outcome.skipped })}\n`);
  return outcome;
}

// ---- the VoiceDesign model, a separate, explicit, confirmed download (never automatic; used only to design a voice) ----------
export type DesignModelState = 'installed' | 'missing';
/** Measured 2026-11-11 on the local Hugging Face cache snapshot of the repo (`du -skL`: 4 414 288 KiB). It is the size shown before the download is confirmed. */
export const QWEN_DESIGN_APPROX_BYTES = 4_414_288 * 1024;

/** `<HF_HOME>`: a user-set `HF_HOME`, else `<real home>/.cache/huggingface`; the same rule as the Qwen child's environment. */
export const hfHomeOf = (env: NodeJS.ProcessEnv, home: string): string => qwenPythonEnv(env, home).HF_HOME as string;

const repoDir = (repo: string) => `models--${repo.replace('/', '--')}`;

/** `installed` only when a cached snapshot of `repo` has config.json, a speech_tokenizer dir and at least one non-empty safetensors file that resolves (a dangling link is an interrupted download). Read-only. */
export async function hfModelStatus(hfHome: string, repo: string): Promise<DesignModelState> {
  const snapshots = join(hfHome, 'hub', repoDir(repo), 'snapshots');
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
/** The VoiceDesign cache state. */
export const designModelStatus = (hfHome: string): Promise<DesignModelState> => hfModelStatus(hfHome, QWEN_DESIGN_MODEL_ID);
/** The Base 0.6B cache state (the model speech clones with). */
export const baseModelStatus = (hfHome: string): Promise<DesignModelState> => hfModelStatus(hfHome, QWEN_MODEL_ID);

/** Total bytes of `repo` from the public Hugging Face API (metadata only, nothing is downloaded); undefined when it cannot be read. */
export async function hfModelSize(repo: string, fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 5000): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body: any = await response.json();
    const total = (Array.isArray(body?.siblings) ? body.siblings : []).reduce((sum: number, file: any) => sum + (typeof file?.size === 'number' && file.size > 0 ? file.size : 0), 0);
    return total > 0 ? total : undefined;
  } catch { return undefined; }
}
export const designModelSize = (fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 5000): Promise<number | undefined> => hfModelSize(QWEN_DESIGN_MODEL_ID, fetchImpl, timeoutMs);

/**
 * The size as shown in the confirmation, always with its source. The confirmation passes nothing and shows the pinned approximate, so no request
 * reaches Hugging Face before the user confirms.
 */
export function describeDesignModelSize(bytes?: number): string {
  return bytes === undefined
    ? `aprox. ${(QWEN_DESIGN_APPROX_BYTES / 1e9).toFixed(1)} GB (medido en la caché local de Hugging Face el 2026-11-11)`
    : `${(bytes / 1e9).toFixed(1)} GB (según la API de Hugging Face)`;
}

/** `cwd` is the child's working directory (a private one, never the caller's project). */
export type DesignRun = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; cwd?: string }) => Promise<{ code: number }>;
const defaultDesignRun: DesignRun = (command, args, { env, signal, cwd }) => new Promise(resolve => {
  execFile(command, args, { cwd, env, signal, timeout: 60 * 60_000, maxBuffer: 1024 * 1024 }, error => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }));
});

/** Downloads `repo` into the Hugging Face cache with the worker's interpreter; the one online step (`HF_HUB_OFFLINE` unset). Requires `confirmed: true`. */
async function downloadHfModel({ repo, name, python, hfHome, home, confirmed, signal, run = defaultDesignRun }: { repo: string; name: string; python: string; hfHome: string; home: string; confirmed: boolean; signal?: AbortSignal; run?: DesignRun }): Promise<void> {
  if (confirmed !== true) throw new Error('Explicit caller confirmation is required.');
  const env = { ...qwenPythonEnv(process.env, home), HF_HOME: hfHome };
  delete env.HF_HUB_OFFLINE;
  const code = `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)})`;
  // Python runs in a fresh private directory, never in the session's working directory.
  if ((await withPrivateCwd(cwd => run(python, [...QWEN_PYTHON_FLAGS, '-c', code], { env, signal, cwd }))).code !== 0) throw new Error(`Download failed: the ${name} model could not be fetched`);
  if (await hfModelStatus(hfHome, repo) !== 'installed') throw new Error(`Download did not complete: the ${name} model is not installed; could not verify it`);
}
/** Downloads the VoiceDesign model. */
export const installDesignModel = (options: { python: string; hfHome: string; home: string; confirmed: boolean; signal?: AbortSignal; run?: DesignRun }): Promise<void> => downloadHfModel({ ...options, repo: QWEN_DESIGN_MODEL_ID, name: 'VoiceDesign' });
/** Downloads the Base 0.6B model, the one speech clones with (the setup's explicit, confirmed download). */
export const installBaseModel = (options: { python: string; hfHome: string; home: string; confirmed: boolean; signal?: AbortSignal; run?: DesignRun }): Promise<void> => downloadHfModel({ ...options, repo: QWEN_MODEL_ID, name: 'Base' });
