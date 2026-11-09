import { DEFAULT_SPEAK_SETTINGS, type SpeakMode } from './speak-settings.ts';

/** Minimal read-only shape of Pi's settled-run messages; unknown content is never voiced. */
export interface SettledSpeechMessage {
  role: string;
  stopReason?: string;
  content?: readonly { type: string; text?: string }[];
}

function spokenProse(markdown: string): string | undefined {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0] + marker[1].length;
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length - 1) fence = undefined;
      continue;
    }
    if (fence || /^\s*(?:diff --git\b|index [\da-f]+\.\.[\da-f]+\b|---\s|\+\+\+\s|@@\s|\+(?:\s|\S)|-(?!\s)(?:\S)|\\ No newline)/.test(line)) continue;
    const prose = line.replace(/`+[^`\n]*`+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[\s>*#-]+/, '').replace(/\s+/g, ' ').trim();
    if (prose) lines.push(prose);
  }
  return lines.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim() || undefined;
}

/** Returns only safe final assistant prose; summary generation is intentionally left to T6. */
export function filterSettledSpeech(messages: readonly SettledSpeechMessage[], mode: SpeakMode = DEFAULT_SPEAK_SETTINGS.mode): string | undefined {
  if (mode === 'summary') return undefined;
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason !== 'stop' || !Array.isArray(last.content)) return undefined;
  // A turn containing a tool call is not a final human-facing answer.
  if (last.content.some(block => block.type === 'toolCall')) return undefined;
  const text = last.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  const prose = spokenProse(text);
  if (!prose) return undefined;
  if (mode === 'all') return prose;
  if (mode !== 'questions-and-results') return undefined;
  // Settled declarative answers are usable results too; do not require a fixed vocabulary.
  // Suppress plainly in-progress narration and speculative plans, even if punctuated.
  if (/^(?:estoy|estamos|voy a|vamos a|i(?:'m| am)|we(?:'re| are)|i(?:'ll| will)|we(?:'ll| will))\b/i.test(prose) || /\b(?:pensando|revisando|buscando|investigando|thinking|checking|searching)\b/i.test(prose)) return undefined;
  return /[?¿.!]/.test(prose) || /\b(?:listo|hecho|resultado|resultados|completado|completada|actualizado|actualizada|creado|creada|encontrado|encontrada|soluci[oó]n|respuesta|finished|done|result|results|completed|updated|created|found|fixed)\b/i.test(prose)
    ? prose : undefined;
}
