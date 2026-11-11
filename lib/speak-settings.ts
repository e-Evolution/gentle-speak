import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { VOICE_CATALOG, isCustomVoiceId } from './speak-voices.ts';

export { VOICE_CATALOG };
export const SPEAK_SETTINGS_SCHEMA = 'gentle-speak.settings/v1';
export const SPEAK_SETTINGS_FILE = 'speak-settings.json';
export type SpeakMode = 'all' | 'questions-and-results' | 'summary';
export interface SpeakSettings {
  enabled: boolean;
  mode: SpeakMode;
  voice: string;
  speed: number;
  summaryModel: { provider: string; id: string } | null;
  /** Opt-in (S8): speak text copied from this Gentle Shell. Optional in files; absent means false. */
  copySpeech: boolean;
  /** S11: the Mac `say` voice name; null picks the best installed Spanish voice. Optional in files. */
  macVoice: string | null;
  /** S11: speak with the Mac voice when the selected Piper or Qwen voice is not installed or fails. Optional in files; absent means true. */
  macFallback: boolean;
  /** S12: speak inside Gentle Dot's engine (its root RPC session). Optional in files; absent means false. */
  dotSpeech: boolean;
  /** S12: `"declined"` once the one-time Gentle Dot offer was refused; null means never asked or accepted. Optional in files. */
  dotOffer: 'declined' | null;
  /** S13: minutes without speech before the warm Qwen worker is closed (integer 1-60); null never. Optional in files; absent means 5. */
  qwenIdleMinutes: number | null;
  shortcuts: { speakLast: string; stop: string; toggle: string; cycleVoice: string; toggleCopy: string };
}
export const DEFAULT_SPEAK_SETTINGS: SpeakSettings = {
  enabled: false,
  mode: 'questions-and-results',
  voice: 'es_MX',
  speed: 1,
  summaryModel: null,
  copySpeech: false,
  macVoice: null,
  macFallback: true,
  dotSpeech: false,
  dotOffer: null,
  qwenIdleMinutes: 10,
  shortcuts: { speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', cycleVoice: 'ctrl+alt+n', toggleCopy: 'ctrl+alt+c' },
};

const reserved = new Set(['ctrl+k', 'ctrl+p', 'alt+k', 'alt+a']);
const keys = ['speakLast', 'stop', 'toggle', 'cycleVoice', 'toggleCopy'];
// Default for v1 files that predate cycleVoice: the first candidate the user
// has not already bound. A fixed ctrl+alt+n made any v1 file that used it for
// another action fail the duplicate check and silently revert to defaults.
const CYCLE_VOICE_DEFAULTS = ['ctrl+alt+n', 'ctrl+alt+b', 'ctrl+alt+j', 'ctrl+alt+u'];
// Same idea for files that predate toggleCopy: the first candidate not already bound.
const TOGGLE_COPY_DEFAULTS = ['ctrl+alt+c', 'ctrl+alt+y', 'ctrl+alt+g', 'ctrl+alt+h'];
const hasKeys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(value: unknown): SpeakSettings | undefined {
  if (!record(value) || !['schema', 'enabled', 'mode', 'voice', 'speed', 'shortcuts'].every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !['schema', 'enabled', 'mode', 'voice', 'speed', 'shortcuts', 'summaryModel', 'copySpeech', 'macVoice', 'macFallback', 'dotSpeech', 'dotOffer', 'qwenIdleMinutes'].includes(key)) || value.schema !== SPEAK_SETTINGS_SCHEMA) return undefined;
  if (Object.hasOwn(value, 'copySpeech') && typeof value.copySpeech !== 'boolean') return undefined;
  if (Object.hasOwn(value, 'dotSpeech') && typeof value.dotSpeech !== 'boolean') return undefined;
  if (Object.hasOwn(value, 'dotOffer') && value.dotOffer !== null && value.dotOffer !== 'declined') return undefined;
  if (Object.hasOwn(value, 'qwenIdleMinutes') && value.qwenIdleMinutes !== null && (typeof value.qwenIdleMinutes !== 'number' || !Number.isInteger(value.qwenIdleMinutes) || value.qwenIdleMinutes < 1 || value.qwenIdleMinutes > 60)) return undefined;
  if (Object.hasOwn(value, 'macFallback') && typeof value.macFallback !== 'boolean') return undefined;
  if (Object.hasOwn(value, 'macVoice') && value.macVoice !== null && (typeof value.macVoice !== 'string' || !/^[\p{L}\p{N} ._()'-]{1,64}$/u.test(value.macVoice))) return undefined;
  const model = value.summaryModel ?? null;
  if (model !== null && (!record(model) || !hasKeys(model, ['provider', 'id']) || ![model.provider, model.id].every(part => typeof part === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part as string)))) return undefined;
  if (typeof value.enabled !== 'boolean' || !['all', 'questions-and-results', 'summary'].includes(value.mode as string)) return undefined;
  if (typeof value.voice !== 'string' || !(Object.hasOwn(VOICE_CATALOG, value.voice) || isCustomVoiceId(value.voice))) return undefined;
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2) return undefined;
  // Older files predate cycleVoice (v1) and toggleCopy: accept them without those keys and fill in defaults.
  if (!record(value.shortcuts) || !(hasKeys(value.shortcuts, keys) || hasKeys(value.shortcuts, keys.slice(0, 4)) || hasKeys(value.shortcuts, keys.slice(0, 3)))) return undefined;
  const bound = keys.slice(0, 3).map(key => value.shortcuts[key]);
  const cycleDefault = CYCLE_VOICE_DEFAULTS.find(key => !bound.includes(key));
  const cycle = value.shortcuts.cycleVoice ?? (!Object.hasOwn(value.shortcuts, 'cycleVoice') ? cycleDefault : undefined);
  const copyDefault = TOGGLE_COPY_DEFAULTS.find(key => ![...bound, cycle].includes(key));
  const shortcuts = [...bound, cycle, value.shortcuts.toggleCopy ?? (!Object.hasOwn(value.shortcuts, 'toggleCopy') ? copyDefault : undefined)];
  if (shortcuts.some(key => typeof key !== 'string' || !/^(?:(?:ctrl|alt|shift)\+)+(?:[a-z0-9]|[.,;\/])$/.test(key) || reserved.has(key)) || new Set(shortcuts).size !== shortcuts.length) return undefined;
  return { enabled: value.enabled, mode: value.mode as SpeakMode, voice: value.voice, speed: value.speed, summaryModel: model as SpeakSettings['summaryModel'], copySpeech: value.copySpeech === true, macVoice: (value.macVoice as string | null | undefined) ?? null, macFallback: value.macFallback !== false, dotSpeech: value.dotSpeech === true, dotOffer: (value.dotOffer as 'declined' | null | undefined) ?? null, qwenIdleMinutes: Object.hasOwn(value, 'qwenIdleMinutes') ? value.qwenIdleMinutes as number | null : 10,
    shortcuts: { speakLast: shortcuts[0] as string, stop: shortcuts[1] as string, toggle: shortcuts[2] as string, cycleVoice: shortcuts[3] as string, toggleCopy: shortcuts[4] as string } };
}

export function parseSpeakSettingsFile(raw: string): SpeakSettings | undefined {
  try { return validate(JSON.parse(raw)); } catch { return undefined; }
}

export function readSpeakSettings(home: string): SpeakSettings {
  try { return parseSpeakSettingsFile(readFileSync(join(home, SPEAK_SETTINGS_FILE), 'utf8')) ?? structuredClone(DEFAULT_SPEAK_SETTINGS); }
  catch { return structuredClone(DEFAULT_SPEAK_SETTINGS); }
}

/** The validated file text for `settings` (same schema as every writer); throws on invalid settings. */
export function serializeSpeakSettings(settings: SpeakSettings): string {
  const valid = validate({ schema: SPEAK_SETTINGS_SCHEMA, ...settings });
  if (!valid) throw new Error('Invalid speak settings');
  return `${JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...valid })}\n`;
}

export function writeSpeakSettings(settings: SpeakSettings, home: string): string {
  const text = serializeSpeakSettings(settings);
  const path = join(home, SPEAK_SETTINGS_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
  }
  return path;
}
