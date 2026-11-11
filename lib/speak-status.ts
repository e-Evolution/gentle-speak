import type { SpeakMode } from './speak-settings.ts';

/** Key of the `ctx.ui.setStatus` row; Gentle Shell renders it inside its INTEGRATIONS section. */
export const SPEAK_STATUS_KEY = 'gentle-speak';

const control = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SpeakStatusInput {
  enabled: boolean;
  voiceLabel: string;
  /** Shown right after the state; omitted rows keep the pre-mode layout. */
  mode?: SpeakMode;
  /** Summary mode needs a configured model; without one it never speaks. */
  summaryReady?: boolean;
  /** Copy speech (S8) state; the row always shows it, with its key. */
  copySpeech: boolean;
  shortcuts: { toggle: string; cycleVoice: string; toggleCopy: string };
}

const MODE_LABELS: Readonly<Record<SpeakMode, string>> = { all: 'todo', 'questions-and-results': 'preguntas y resultados', summary: 'resumen' };

/**
 * One plain-text row, e.g. `SPEAK ● on · modo todo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c`.
 * Gentle Shell strips control characters and collapses spaces (sanitizeStatus) and wraps rows
 * at word boundaries in its 50-column rail, so the state stays in the first ~12 columns.
 */
export function formatSpeakStatus({ enabled, voiceLabel, mode, summaryReady, copySpeech, shortcuts }: SpeakStatusInput): string {
  const label = voiceLabel.replace(control, ' ').replace(/ +/g, ' ').trim();
  const modeLabel = mode ? ` · modo ${MODE_LABELS[mode]}${mode === 'summary' && !summaryReady ? ' sin modelo' : ''}` : '';
  return `SPEAK ${enabled ? '● on' : '○ off'}${modeLabel} · ${label} · ${shortcuts.toggle} on/off · ${shortcuts.cycleVoice} voz · copia ${copySpeech ? '●' : '○'} ${shortcuts.toggleCopy}`;
}

/** The next available voice after `current` in `order`, wrapping; undefined when no other voice is available. */
export function nextAvailableVoice(order: readonly string[], current: string, available: Readonly<Record<string, boolean>>): string | undefined {
  const start = order.indexOf(current);
  for (let step = 1; step < order.length; step++) {
    const id = order[(start + step) % order.length];
    if (id !== current && available[id]) return id;
  }
  return undefined;
}

/** `/speak` menu entries for every catalog voice, in catalog order. */
export function voiceMenuEntries(catalog: Readonly<Record<string, { label: string }>>, available: Readonly<Record<string, boolean>>): Array<{ id: string; text: string }> {
  return Object.entries(catalog).map(([id, voice]) => ({ id, text: `Voice: ${voice.label} (${id}) — ${available[id] ? 'installed' : 'not installed'}` }));
}
