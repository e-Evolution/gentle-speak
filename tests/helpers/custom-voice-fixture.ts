// T42 helpers: PCM WAV builders and a temp shared home. Scratch lives under mkdtemp and is removed by `close()`.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** A canonical PCM WAV of `seconds` of a quiet sine. */
export function makeWav(seconds: number, { rate = 24000, channels = 1, bits = 16, format = 1 }: { rate?: number; channels?: number; bits?: number; format?: number } = {}): Buffer {
  const bytes = Math.round(seconds * rate) * channels * (bits / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(format, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * (bits / 8), 28); header.writeUInt16LE(channels * (bits / 8), 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  const body = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes && bits === 16; i += 2 * channels) for (let c = 0; c < channels; c++) body.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 220 * (i / (2 * channels)) / rate)), i + 2 * c);
  return Buffer.concat([header, body]);
}

export function tempHome() {
  const root = mkdtempSync(join(tmpdir(), 'gs-custom-'));
  const home = join(root, '.gentle-speak');
  mkdirSync(home, { recursive: true });
  return { root, home, custom: join(home, 'voices', 'custom'), close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Writes a custom voice entry by hand (bypassing the library) so tests can make valid and invalid ones. */
export function writeEntry(custom: string, id: string, { meta = {}, wav = makeWav(4), voiceJson }: { meta?: Record<string, unknown>; wav?: Buffer | null; voiceJson?: string } = {}) {
  const dir = join(custom, id);
  mkdirSync(dir, { recursive: true });
  if (wav) writeFileSync(join(dir, 'reference.wav'), wav);
  const base = { id, label: 'Mi voz', transcript: 'Hola, esta es mi voz.', description: 'cálida', language: 'es', source: 'designed', created: '2026-11-11T00:00:00.000Z', sha256: wav ? sha256(wav) : '0'.repeat(64) };
  writeFileSync(join(dir, 'voice.json'), voiceJson ?? JSON.stringify({ ...base, ...meta }));
  return dir;
}
