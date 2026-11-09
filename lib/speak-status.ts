import type { CatalogVoice } from './speak-voices.ts';

/** Key of the `ctx.ui.setStatus` row; Gentle Shell renders it inside its INTEGRATIONS section. */
export const SPEAK_STATUS_KEY = 'gentle-speak';

const control = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SpeakStatusInput {
  enabled: boolean;
  voiceLabel: string;
  shortcuts: { toggle: string; cycleVoice: string };
}

/**
 * One plain-text row, e.g. `SPEAK ● on · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz`.
 * Gentle Shell strips control characters and collapses spaces (sanitizeStatus) and wraps rows
 * at word boundaries in its 50-column rail, so the state stays in the first ~12 columns.
 */
export function formatSpeakStatus({ enabled, voiceLabel, shortcuts }: SpeakStatusInput): string {
  const label = voiceLabel.replace(control, ' ').replace(/ +/g, ' ').trim();
  return `SPEAK ${enabled ? '● on' : '○ off'} · ${label} · ${shortcuts.toggle} on/off · ${shortcuts.cycleVoice} voz`;
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
export function voiceMenuEntries(catalog: Readonly<Record<string, CatalogVoice>>, available: Readonly<Record<string, boolean>>): Array<{ id: string; text: string }> {
  return Object.entries(catalog).map(([id, voice]) => ({ id, text: `Voice: ${voice.label} (${id}) — ${available[id] ? 'installed' : 'not installed'}` }));
}
