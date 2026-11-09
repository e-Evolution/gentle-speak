import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A locale-keyed catalog; adding a language does not change the persisted format. */
export const VOICE_CATALOG: Record<string, { locale: string; language: string; label: string }> = {
  es_MX: { locale: 'es_MX', language: 'es', label: 'Español (México)' },
  es_ES: { locale: 'es_ES', language: 'es', label: 'Español (España)' },
};
export const SPEAK_SETTINGS_SCHEMA = 'gentle-speak.settings/v1';
export const SPEAK_SETTINGS_FILE = 'speak-settings.json';
export type SpeakMode = 'all' | 'questions-and-results' | 'summary';
export interface SpeakSettings {
  enabled: boolean;
  mode: SpeakMode;
  voice: string;
  speed: number;
  summaryModel: { provider: string; id: string } | null;
  shortcuts: { speakLast: string; stop: string; toggle: string };
}
export const DEFAULT_SPEAK_SETTINGS: SpeakSettings = {
  enabled: false,
  mode: 'questions-and-results',
  voice: 'es_MX',
  speed: 1,
  summaryModel: null,
  shortcuts: { speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m' },
};

const reserved = new Set(['ctrl+k', 'ctrl+p', 'alt+k', 'alt+a']);
const keys = ['speakLast', 'stop', 'toggle'];
const hasKeys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(value: unknown): SpeakSettings | undefined {
  if (!record(value) || ![6, 7].includes(Object.keys(value).length) || !['schema', 'enabled', 'mode', 'voice', 'speed', 'shortcuts'].every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !['schema', 'enabled', 'mode', 'voice', 'speed', 'shortcuts', 'summaryModel'].includes(key)) || value.schema !== SPEAK_SETTINGS_SCHEMA) return undefined;
  const model = value.summaryModel ?? null;
  if (model !== null && (!record(model) || !hasKeys(model, ['provider', 'id']) || ![model.provider, model.id].every(part => typeof part === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part as string)))) return undefined;
  if (typeof value.enabled !== 'boolean' || !['all', 'questions-and-results', 'summary'].includes(value.mode as string)) return undefined;
  if (typeof value.voice !== 'string' || !Object.hasOwn(VOICE_CATALOG, value.voice)) return undefined;
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2) return undefined;
  if (!record(value.shortcuts) || !hasKeys(value.shortcuts, keys)) return undefined;
  const shortcuts = keys.map(key => value.shortcuts[key]);
  if (shortcuts.some(key => typeof key !== 'string' || !/^(?:(?:ctrl|alt|shift)\+)+(?:[a-z0-9]|[.,;\/])$/.test(key) || reserved.has(key)) || new Set(shortcuts).size !== shortcuts.length) return undefined;
  return { enabled: value.enabled, mode: value.mode as SpeakMode, voice: value.voice, speed: value.speed, summaryModel: model as SpeakSettings['summaryModel'],
    shortcuts: { speakLast: shortcuts[0] as string, stop: shortcuts[1] as string, toggle: shortcuts[2] as string } };
}

export function parseSpeakSettingsFile(raw: string): SpeakSettings | undefined {
  try { return validate(JSON.parse(raw)); } catch { return undefined; }
}

export function readSpeakSettings(home: string): SpeakSettings {
  try { return parseSpeakSettingsFile(readFileSync(join(home, SPEAK_SETTINGS_FILE), 'utf8')) ?? structuredClone(DEFAULT_SPEAK_SETTINGS); }
  catch { return structuredClone(DEFAULT_SPEAK_SETTINGS); }
}

export function writeSpeakSettings(settings: SpeakSettings, home: string): string {
  const valid = validate({ schema: SPEAK_SETTINGS_SCHEMA, ...settings });
  if (!valid) throw new Error('Invalid speak settings');
  const path = join(home, SPEAK_SETTINGS_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...valid })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
  }
  return path;
}
