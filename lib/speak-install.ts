import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

/** Explicit, data-only acquisition. Importing this module never downloads or loads native code. */
export interface SpeakModelManifest {
  id: string;
  revision: string;
  baseUrl: string;
  files: Array<{ name: string; size: number; sha256: string }>;
  redirects: Array<{ origin: string; pathPrefix: string }>;
}
const revision = 'e7229f7d33a10e145e109b886d661984201ac3c4';
const root = `https://huggingface.co/rhasspy/piper-voices/resolve/${revision}`;
const redirects = [
  { origin: 'https://huggingface.co', pathPrefix: '/api/resolve-cache/models/rhasspy/piper-voices/' + revision + '/' },
  { origin: 'https://us.aws.cdn.hf.co', pathPrefix: '/xet-bridge-us/' },
];
export const SPEAK_MODELS: Readonly<Record<'es_MX' | 'es_ES', SpeakModelManifest>> = {
  es_MX: { id: `es_MX-claude-high-${revision.slice(0, 12)}`, revision, baseUrl: `${root}/es/es_MX/claude/high`, redirects, files: [
    { name: 'es_MX-claude-high.onnx', size: 63122309, sha256: '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0' },
    { name: 'es_MX-claude-high.onnx.json', size: 4963, sha256: '1afc81f703c0e4cb3b4d7c0dca096b8b54a98806807f0170cf5eb5557723c12d' },
  ] },
  es_ES: { id: `es_ES-davefx-medium-${revision.slice(0, 12)}`, revision, baseUrl: `${root}/es/es_ES/davefx/medium`, redirects, files: [
    { name: 'es_ES-davefx-medium.onnx', size: 63201294, sha256: '6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917' },
    { name: 'es_ES-davefx-medium.onnx.json', size: 4817, sha256: '0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842' },
  ] },
};
export type SpeakFetch = (url: string, init: { signal: AbortSignal; redirect: 'manual'; headers: Record<string, string> }) => Promise<Response>;
export interface SpeakInstallOptions {
  home: string;
  voice?: keyof typeof SPEAK_MODELS;
  /** The caller must obtain user confirmation before setting this for each install request. */
  confirmed?: boolean;
  manifest?: SpeakModelManifest;
  fetch?: SpeakFetch;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  idleMs?: number;
  totalMs?: number;
}
export class SpeakInstallError extends Error {
  readonly code: 'confirmation' | 'unsupported' | 'cancelled' | 'timeout' | 'http' | 'redirect' | 'size' | 'integrity' | 'io';
  constructor(code: SpeakInstallError['code'], message: string) { super(message); this.name = 'SpeakInstallError'; this.code = code; }
}
const fingerprint = (manifest: SpeakModelManifest | SpeakRuntimeManifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
async function digestFile(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}
async function awaitTransfer<T>(pending: Promise<T>, controller: AbortController, idleMs: number): Promise<T> {
  const idle = setTimeout(() => controller.abort(new SpeakInstallError('timeout', 'Download stalled.')), idleMs);
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { clearTimeout(idle); controller.signal.removeEventListener('abort', onAbort); }
}
const safe = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function validate(manifest: SpeakModelManifest): void {
  if (!safe.test(manifest.id) || !manifest.files.length || !manifest.files.every(file => safe.test(file.name) && !file.name.endsWith('.') && Number.isSafeInteger(file.size) && file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256)) || new Set(manifest.files.map(file => file.name.toLowerCase())).size !== manifest.files.length) throw new SpeakInstallError('unsupported', 'Unsafe model manifest.');
  const url = new URL(manifest.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SpeakInstallError('unsupported', 'Unsafe model URL.');
}
export async function readSpeakModelStatus({ home, voice = 'es_MX', manifest = SPEAK_MODELS[voice] }: Pick<SpeakInstallOptions, 'home' | 'voice' | 'manifest'>): Promise<{ state: 'missing' | 'installed' | 'invalid'; path: string }> {
  validate(manifest);
  const path = join(home, 'models', manifest.id);
  try { if (!(await lstat(path)).isDirectory()) return { state: 'invalid', path }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', path }; throw error; }
  try {
    const marker = JSON.parse(await readFile(join(path, '.gentle-speak.json'), 'utf8'));
    if (marker.schema !== 1 || marker.fingerprint !== fingerprint(manifest)) return { state: 'invalid', path };
    for (const file of manifest.files) {
      const info = await lstat(join(path, file.name));
      if (!info.isFile() || info.size !== file.size || await digestFile(join(path, file.name), 'sha256') !== file.sha256) return { state: 'invalid', path };
    }
    return { state: 'installed', path };
  } catch { return { state: 'invalid', path }; }
}

async function publishPayload(payload: string, path: string, status: () => Promise<{ state: 'missing' | 'installed' | 'invalid' }>, controller: AbortController): Promise<{ path: string; alreadyInstalled: boolean }> {
  if (controller.signal.aborted) throw controller.signal.reason;
  try { await rename(payload, path); return { path, alreadyInstalled: false }; }
  catch (error) {
    // Another installer may have atomically published the same verified artifact.
    if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') && (await status()).state === 'installed') return { path, alreadyInstalled: true };
    throw error;
  }
}
export async function installSpeakModel(options: SpeakInstallOptions): Promise<{ path: string; alreadyInstalled: boolean }> {
  if (!options.confirmed) throw new SpeakInstallError('confirmation', 'Explicit caller confirmation is required.');
  const manifest = options.manifest ?? SPEAK_MODELS[options.voice ?? 'es_MX'];
  validate(manifest);
  if (options.signal?.aborted) throw new SpeakInstallError('cancelled', 'Model install was cancelled.');
  const current = await readSpeakModelStatus({ home: options.home, manifest });
  if (current.state === 'installed') return { path: current.path, alreadyInstalled: true };
  const controller = new AbortController();
  const cancel = () => controller.abort(new SpeakInstallError('cancelled', 'Model install was cancelled.'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const totalTimer = setTimeout(() => controller.abort(new SpeakInstallError('timeout', 'Model install timed out.')), options.totalMs ?? 2 * 60 * 60_000);
  const wait = <T>(pending: Promise<T>) => awaitTransfer(pending, controller, options.idleMs ?? 60_000);
  let staging: string | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    staging = await mkdtemp(join(options.home, '.speak-staging-'));
    const payload = join(staging, 'payload');
    await mkdir(payload, { mode: 0o700 });
    const total = manifest.files.reduce((n, file) => n + file.size, 0);
    let received = 0;
    for (const file of manifest.files) {
      let url = new URL(`${manifest.baseUrl}/${file.name}`);
      let response: Response | undefined;
      for (let hop = 0; hop <= 5; hop++) {
        response = await wait((options.fetch ?? fetch)(url.href, { signal: controller.signal, redirect: 'manual', headers: { 'accept-encoding': 'identity' } }));
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        void response.body?.cancel().catch(() => {});
        if (!location || hop === 5) throw new SpeakInstallError('redirect', 'Missing or excessive redirect.');
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || !manifest.redirects.some(rule => next.origin === rule.origin && next.pathname.startsWith(rule.pathPrefix))) throw new SpeakInstallError('redirect', 'Refused untrusted redirect.');
        url = next;
      }
      if (!response || response.status !== 200 || !response.body) throw new SpeakInstallError('http', `Model request failed: HTTP ${response?.status}.`);
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== file.size) { void response.body.cancel().catch(() => {}); throw new SpeakInstallError('size', 'Unexpected model size.'); }
      const handle = await open(join(payload, file.name), 'wx', 0o600);
      const reader = response.body.getReader();
      const hash = createHash('sha256');
      let count = 0;
      try {
        for (;;) {
          const { done, value } = await wait(reader.read());
          if (done) break;
          count += value.byteLength;
          if (count > file.size) throw new SpeakInstallError('size', 'Model exceeds pinned size.');
          hash.update(value);
          let written = 0;
          while (written < value.byteLength) written += (await handle.write(value, written, value.byteLength - written)).bytesWritten;
          received += value.byteLength;
          options.onProgress?.(received, total);
        }
      } finally { void reader.cancel().catch(() => {}); await handle.close(); }
      if (count !== file.size) throw new SpeakInstallError('size', 'Model ended before pinned size.');
      if (hash.digest('hex') !== file.sha256) throw new SpeakInstallError('integrity', 'Model SHA256 digest mismatch.');
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    await writeFile(join(payload, '.gentle-speak.json'), JSON.stringify({ schema: 1, fingerprint: fingerprint(manifest) }), { flag: 'wx', mode: 0o600 });
    await mkdir(dirname(current.path), { recursive: true, mode: 0o700 });
    const latest = await readSpeakModelStatus({ home: options.home, manifest });
    if (latest.state === 'installed') return { path: current.path, alreadyInstalled: true };
    // Never replace an invalid existing install: a caller must resolve it explicitly.
    if (latest.state === 'invalid') throw new SpeakInstallError('io', 'Existing invalid model directory requires manual resolution.');
    return publishPayload(payload, current.path, () => readSpeakModelStatus({ home: options.home, manifest }), controller);
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', cancel);
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

// Independent native runtime pins: npm registry dist.integrity, dist.unpackedSize,
// and dist.fileCount from the installed gentle-pi 4.7.0 artifact catalog.
export const SPEAK_TARGETS = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64'] as const;
export type SpeakTarget = typeof SPEAK_TARGETS[number];
export interface SpeakRuntimePackage {
  name: string; version: string; tarball: string; size: number; integrity: string;
  unpackedSize: number; fileCount: number; requiredFiles: string[];
}
export interface SpeakRuntimeManifest {
  id: string; target: SpeakTarget; packages: SpeakRuntimePackage[];
}
const npmPackage = (name: string, version: string, size: number, integrity: string, unpackedSize: number, fileCount: number, requiredFiles: string[]): SpeakRuntimePackage => ({
  name, version, tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, size, integrity, unpackedSize, fileCount, requiredFiles,
});
const sherpa = npmPackage('sherpa-onnx-node', '1.13.8', 11954, 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==', 61221, 19, ['package.json', 'sherpa-onnx.js', 'addon.js', 'addon-static-import.js', 'non-streaming-tts.js']);
const cpal = npmPackage('node-cpal', '1.0.0', 7723259, 'sha512-d71jIzKDjw1HepqaJQMPd+/k3ZLqYZWhLAv6a8aafIGnYoA1QWlShA5iB5CgijIJtQxq9PdQAk99JQKspqlnTA==', 20363834, 40, ['package.json', 'index.js', 'facade.js', 'cpal-values.js']);
const platformPins: Record<SpeakTarget, [number, string, number, number]> = {
  'darwin-x64': [11191481, 'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==', 37678686, 7],
  'darwin-arm64': [10047754, 'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==', 34089738, 7],
  'linux-x64': [11089653, 'sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==', 33381117, 7],
  'linux-arm64': [13910679, 'sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==', 40306856, 7],
  'win32-x64': [8894875, 'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==', 23453246, 8],
};
export function speakRuntimeManifest(target: SpeakTarget): SpeakRuntimeManifest {
  if (!SPEAK_TARGETS.includes(target)) throw new SpeakInstallError('unsupported', `Unsupported runtime target: ${String(target)}.`);
  const name = `sherpa-onnx-${target.replace(/^win32-/, 'win-')}`;
  const [size, integrity, unpackedSize, fileCount] = platformPins[target];
  return {
    id: `sherpa-onnx-1.13.8-node-cpal-1.0.0-${target}`, target,
    packages: [sherpa, npmPackage(name, '1.13.8', size, integrity, unpackedSize, fileCount, ['package.json', 'sherpa-onnx.node']),
      { ...cpal, requiredFiles: [...cpal.requiredFiles, `bin/${target}/index.node`] }],
  };
}
const safeSegment = (value: string) => value !== '' && value !== '.' && value !== '..' && !/[\\:\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(value);
const safePath = (value: string) => value.split('/').every(safeSegment);
const tarField = (block: Buffer, start: number, end: number): string => {
  const field = block.subarray(start, end); const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8');
};
const tarOctal = (block: Buffer, start: number, end: number): number => {
  const text = tarField(block, start, end).trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
};
interface ArchiveFile { path: string; data: Buffer; executable: boolean }
function readPackageArchive(compressed: Buffer, pkg: SpeakRuntimePackage): ArchiveFile[] {
  const reject = (why: string): never => { throw new SpeakInstallError('integrity', `${pkg.name}: unsafe archive (${why}).`); };
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: pkg.unpackedSize + (pkg.fileCount + 2) * 1024 + 10240 }); }
  catch { return reject('decompression limit'); }
  const entries: ArchiveFile[] = [];
  const files = new Set<string>(); const dirs = new Set<string>();
  let offset = 0; let unpacked = 0; let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) reject('trailing data');
      ended = true; break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (tarOctal(header, 148, 156) !== checksum || tarField(header, 257, 263) !== 'ustar') reject('header');
    if (header[156] !== 0 && header[156] !== 0x30) reject('non-regular entry');
    const name = tarField(header, 0, 100); const prefix = tarField(header, 345, 500);
    const full = prefix ? `${prefix}/${name}` : name;
    if (!full.startsWith('package/')) reject('outside package root');
    const relative = full.slice(8);
    if (!safePath(relative)) reject('unsafe path');
    const segments = relative.split('/'); const key = relative.toLowerCase();
    if (files.has(key) || dirs.has(key)) reject('duplicate or file/directory collision');
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/').toLowerCase();
      if (files.has(parent)) reject('file/directory collision');
      dirs.add(parent);
    }
    files.add(key);
    const size = tarOctal(header, 124, 136);
    if (!Number.isSafeInteger(size) || size < 0) reject('invalid size');
    unpacked += size;
    if (entries.length >= pkg.fileCount || unpacked > pkg.unpackedSize) reject('unpacked bounds');
    const start = offset + 512;
    if (start + size > tar.length) reject('truncated file');
    entries.push({ path: relative, data: tar.subarray(start, start + size), executable: (tarOctal(header, 100, 108) & 0o111) !== 0 });
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!ended) reject('missing end marker');
  for (const required of pkg.requiredFiles) if (!files.has(required.toLowerCase())) reject(`missing ${required}`);
  return entries;
}
export interface SpeakRuntimeOptions extends Omit<SpeakInstallOptions, 'voice' | 'manifest'> {
  target: SpeakTarget;
  /** For isolated tests; production callers use the pinned default. */
  manifest?: SpeakRuntimeManifest;
}
function validateRuntime(manifest: SpeakRuntimeManifest, target: SpeakTarget): void {
  if (!SPEAK_TARGETS.includes(target) || manifest.target !== target || !safe.test(manifest.id) || manifest.packages.length !== 3) throw new SpeakInstallError('unsupported', 'Unsupported runtime manifest.');
  const names = new Set<string>();
  for (const pkg of manifest.packages) {
    if (!safe.test(pkg.name) || names.has(pkg.name.toLowerCase()) || !safe.test(pkg.version) || !Number.isSafeInteger(pkg.size) || pkg.size <= 0 || !Number.isSafeInteger(pkg.unpackedSize) || pkg.unpackedSize <= 0 || !Number.isSafeInteger(pkg.fileCount) || pkg.fileCount <= 0 || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) || !pkg.requiredFiles.every(safePath)) throw new SpeakInstallError('unsupported', 'Unsafe runtime manifest.');
    const url = new URL(pkg.tarball);
    if (url.protocol !== 'https:' || url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) throw new SpeakInstallError('unsupported', 'Unsafe runtime source.');
    names.add(pkg.name.toLowerCase());
  }
}
export async function readSpeakRuntimeStatus({ home, target, manifest = speakRuntimeManifest(target) }: Pick<SpeakRuntimeOptions, 'home' | 'target' | 'manifest'>): Promise<{ state: 'missing' | 'installed' | 'invalid'; path: string }> {
  validateRuntime(manifest, target);
  const path = join(home, 'runtime', manifest.id);
  try { if (!(await lstat(path)).isDirectory()) return { state: 'invalid', path }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', path }; throw error; }
  try {
    const marker = JSON.parse(await readFile(join(path, '.gentle-speak-runtime.json'), 'utf8'));
    if (marker.schema !== 1 || marker.fingerprint !== fingerprint(manifest) || !Array.isArray(marker.files)) return { state: 'invalid', path };
    const expected = new Set(marker.files.map((file: { path?: unknown }) => file?.path));
    if (expected.size !== marker.files.length || expected.size < manifest.packages.reduce((count, pkg) => count + pkg.requiredFiles.length, 0) ||
      manifest.packages.some(pkg => pkg.requiredFiles.some(required => !expected.has(`node_modules/${pkg.name}/${required}`)))) return { state: 'invalid', path };
    for (const file of marker.files) {
      if (typeof file.path !== 'string' || !safePath(file.path) || !Number.isSafeInteger(file.size) || !/^[a-f0-9]{64}$/.test(file.sha256)) return { state: 'invalid', path };
      const entry = join(path, ...file.path.split('/'));
      const stat = await lstat(entry);
      if (!stat.isFile() || stat.size !== file.size || await digestFile(entry, 'sha256') !== file.sha256) return { state: 'invalid', path };
    }
    return { state: 'installed', path };
  } catch { return { state: 'invalid', path }; }
}
export async function installSpeakRuntime(options: SpeakRuntimeOptions): Promise<{ path: string; alreadyInstalled: boolean }> {
  if (!options.confirmed) throw new SpeakInstallError('confirmation', 'Explicit caller confirmation is required.');
  const manifest = options.manifest ?? speakRuntimeManifest(options.target);
  validateRuntime(manifest, options.target);
  if (options.signal?.aborted) throw new SpeakInstallError('cancelled', 'Runtime install was cancelled.');
  const current = await readSpeakRuntimeStatus({ home: options.home, target: options.target, manifest });
  if (current.state === 'installed') return { path: current.path, alreadyInstalled: true };
  const controller = new AbortController();
  const cancel = () => controller.abort(new SpeakInstallError('cancelled', 'Runtime install was cancelled.'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new SpeakInstallError('timeout', 'Runtime install timed out.')), options.totalMs ?? 20 * 60_000);
  const wait = <T>(pending: Promise<T>) => awaitTransfer(pending, controller, options.idleMs ?? 60_000);
  let staging: string | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    staging = await mkdtemp(join(options.home, '.speak-staging-'));
    const payload = join(staging, 'payload'); const downloads = join(staging, 'downloads');
    await mkdir(payload, { mode: 0o700 }); await mkdir(downloads, { mode: 0o700 });
    const archives: Array<[SpeakRuntimePackage, ArchiveFile[]]> = [];
    const total = manifest.packages.reduce((n, pkg) => n + pkg.size, 0); let received = 0;
    for (const pkg of manifest.packages) {
      const response = await wait((options.fetch ?? fetch)(pkg.tarball, { signal: controller.signal, redirect: 'manual', headers: { 'accept-encoding': 'identity' } }));
      if (response.status !== 200 || !response.body) throw new SpeakInstallError('http', `Runtime request failed: HTTP ${response.status}.`);
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== pkg.size) throw new SpeakInstallError('size', 'Unexpected runtime tarball size.');
      const reader = response.body.getReader();
      const file = await open(join(downloads, `${pkg.name}.tgz`), 'wx', 0o600);
      let size = 0; const hash = createHash('sha512');
      try {
        for (;;) {
          const { done, value } = await wait(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > pkg.size) throw new SpeakInstallError('size', 'Runtime tarball exceeds pinned size.');
          hash.update(value);
          let written = 0;
          while (written < value.byteLength) written += (await file.write(value, written, value.byteLength - written)).bytesWritten;
          received += value.byteLength;
          options.onProgress?.(received, total);
        }
      } finally { void reader.cancel().catch(() => {}); await file.close(); }
      if (size !== pkg.size) throw new SpeakInstallError('size', 'Runtime tarball ended early.');
      if (`sha512-${hash.digest('base64')}` !== pkg.integrity) throw new SpeakInstallError('integrity', 'Runtime SHA512 digest mismatch.');
    }
    // Verify all archives before extracting even a single file.
    for (const pkg of manifest.packages) archives.push([pkg, readPackageArchive(await readFile(join(downloads, `${pkg.name}.tgz`)), pkg)]);
    const files: Array<{ path: string; size: number; sha256: string }> = [];
    for (const [pkg, entries] of archives) {
      const root = join(payload, 'node_modules', pkg.name);
      for (const entry of entries) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const dest = join(root, ...entry.path.split('/'));
        if (!dest.startsWith(root + sep)) throw new SpeakInstallError('integrity', 'Archive path escaped package root.');
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, entry.data, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
        files.push({ path: `node_modules/${pkg.name}/${entry.path}`, size: entry.data.length, sha256: createHash('sha256').update(entry.data).digest('hex') });
      }
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    await writeFile(join(payload, '.gentle-speak-runtime.json'), JSON.stringify({ schema: 1, fingerprint: fingerprint(manifest), files }), { flag: 'wx', mode: 0o600 });
    await mkdir(dirname(current.path), { recursive: true, mode: 0o700 });
    const latest = await readSpeakRuntimeStatus({ home: options.home, target: options.target, manifest });
    if (latest.state === 'installed') return { path: current.path, alreadyInstalled: true };
    if (latest.state === 'invalid') throw new SpeakInstallError('io', 'Existing invalid runtime directory requires manual resolution.');
    return publishPayload(payload, current.path, () => readSpeakRuntimeStatus({ home: options.home, target: options.target, manifest }), controller);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
