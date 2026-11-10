import { filterSettledSpeech } from './speak-filter.ts';

/** What one speculative synthesis resolves to; the WAVs are owned by the planner until `settle` hands them over. */
export type SpeculativeSynthesis = { ok: true; wavs: string[] } | { ok: false; cancelled?: boolean; message?: string };

/** A synthesis in progress; `handle` is opaque to the planner and lets the caller consume the parts while it still runs. */
export type SpeculativeFlight = Promise<SpeculativeSynthesis> & { handle?: unknown };

export interface SpeculativeDeps {
  /** Synthesizes `text` into WAV files without playing; must resolve (not reject) and honour `signal`. */
  synthesize: (text: string, signal: AbortSignal) => SpeculativeFlight;
  /** Deletes WAV files that will never play. */
  discard: (wavs: readonly string[]) => void;
  /**
   * Prepares raw markdown into the prose S1 would speak. Default: `filterSettledSpeech` in `all` mode (code blocks, diffs,
   * emphasis and the rest are stripped), applied per paragraph so a paragraph break still ends a sentence.
   */
  prepare?: (text: string) => string | undefined;
  /** Upper bound of speculated text pending or buffered. Default 500. */
  maxAheadChars?: number;
}

export interface SpeculativeSettlement {
  /** Buffered WAVs, in order, whose sentences exactly equal the start of the final text. */
  wavs: string[];
  /** The (whitespace-normalized) matched text. */
  matchedText: string;
  /** What is still to be synthesized after the matched prefix. */
  remainderText: string;
  /**
   * A synthesis still running at settle whose sentence continues the matched text. It is NOT aborted: it follows `wavs` in order and
   * the caller owns it (consume `handle`, or call `abort` and discard its WAVs once `done` resolves). `matchedText` includes it.
   */
  inflight?: { text: string; handle: unknown; done: Promise<SpeculativeSynthesis>; abort: () => void };
}

export const DEFAULT_MAX_AHEAD_CHARS = 500;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

const defaultPrepare = (text: string) => filterSettledSpeech([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }], 'all');

/** Splits markdown into paragraphs (blank lines outside a code fence), keeping a still-open fence inside its paragraph. */
function paragraphs(text: string): string[] {
  const result: string[] = [];
  let current: string[] = [], fence: string | undefined;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) fence = fence ? (marker[1][0] === fence ? undefined : fence) : marker[1][0];
    if (!fence && !marker && !line.trim() && index < lines.length - 1) { if (current.length) result.push(current.join('\n')); current = []; return; }
    current.push(line);
  });
  if (current.length) result.push(current.join('\n'));
  return result;
}

/**
 * Completed sentences of the prepared text. A sentence ends at `. ! ? …` followed by whitespace, or at a paragraph break;
 * the trailing incomplete part is never returned. Sentences inside a still-open code fence are excluded by the preparation.
 */
export function completedSentences(text: string, prepare: (text: string) => string | undefined = defaultPrepare): string[] {
  const parts = paragraphs(text);
  const prepared: string[] = [];
  parts.forEach((part, index) => {
    let prose = prepare(part);
    if (!prose) return;
    // Prepared prose is trimmed, so what follows the last character is judged on the raw text.
    if (index < parts.length - 1 || /\s$/.test(text)) prose += '\n';
    prepared.push(prose);
  });
  const joined = prepared.join('');
  const sentences: string[] = [];
  let carry = '';
  const pattern = /[\s\S]*?(?:[.!?…]+(?=\s)|\n)/y;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(joined))) {
    const piece = normalize(carry + ' ' + match[0]);
    // A bare list number ("1.") is not a sentence; it belongs to the next one.
    if (/^\d+[.)]?$/.test(piece.replace(/[.]$/, ''))) { carry = piece; continue; }
    carry = '';
    if (piece) sentences.push(piece);
  }
  return sentences;
}

export function createSpeculativePlanner(deps: SpeculativeDeps) {
  const maxAhead = deps.maxAheadChars ?? DEFAULT_MAX_AHEAD_CHARS;
  const prepare = deps.prepare ?? defaultPrepare;
  let sentences: string[] = [];
  /** Sentence texts already dispatched, in order: buffered ones first, the in-flight one last. */
  let dispatched: string[] = [];
  let buffer: Array<{ text: string; wavs: string[] }> = [];
  let inflight: { controller: AbortController; text: string; promise?: SpeculativeFlight; adopted?: boolean } | undefined;
  let failed = false, disposed = false;

  const pendingChars = () => dispatched.reduce((sum, text) => sum + text.length, 0);

  function reset() {
    const flying = inflight; inflight = undefined;
    flying?.controller.abort();
    for (const entry of buffer) deps.discard(entry.wavs);
    buffer = []; dispatched = []; sentences = []; failed = false;
  }

  function pump() {
    if (disposed || failed || inflight) return;
    const text = sentences[dispatched.length];
    if (text === undefined || pendingChars() + text.length > maxAhead) return;
    const flight: NonNullable<typeof inflight> = { controller: new AbortController(), text };
    inflight = flight;
    dispatched.push(text);
    const started = deps.synthesize(text, flight.controller.signal);
    flight.promise = started;
    started.then(result => result, () => ({ ok: false } as SpeculativeSynthesis)).then(result => {
      if (flight.adopted) return; // handed over at settle: the caller owns the result
      if (inflight !== flight) { if (result.ok) deps.discard(result.wavs); return; } // cancelled, settled or disposed meanwhile
      inflight = undefined;
      if (result.ok) buffer.push({ text, wavs: result.wavs });
      else { dispatched.pop(); failed = true; } // never retry on its own; the settle remainder covers it
      pump();
    });
  }

  return {
    /** Feed the assistant message's growing text (as from `message_update`). */
    update(fullTextSoFar: string) {
      if (disposed) return;
      const next = completedSentences(fullTextSoFar, prepare);
      // Text that no longer extends what was dispatched (rewrite, retry) invalidates the speculation.
      if (dispatched.some((text, index) => next[index] !== text)) reset();
      sentences = next;
      pump();
    },
    /** Matches the buffer against the final spoken text; everything unmatched is discarded and the planner is reusable. */
    settle(finalSpokenText: string): SpeculativeSettlement {
      const final = normalize(finalSpokenText);
      let matched = '', count = 0;
      if (!disposed) {
        for (const entry of buffer) {
          const candidate = matched ? `${matched} ${entry.text}` : entry.text;
          if (!final.startsWith(candidate) || (final.length > candidate.length && final[candidate.length] !== ' ')) break;
          matched = candidate; count++;
        }
      }
      const allMatched = count === buffer.length;
      const wavs = buffer.slice(0, count).flatMap(entry => entry.wavs);
      for (const entry of buffer.slice(count)) deps.discard(entry.wavs);
      buffer = [];
      const flying = inflight; inflight = undefined;
      let keep: SpeculativeSettlement['inflight'];
      if (flying && !disposed && allMatched) {
        const candidate = matched ? `${matched} ${flying.text}` : flying.text;
        if (final.startsWith(candidate) && (final.length === candidate.length || final[candidate.length] === ' ')) {
          flying.adopted = true;
          matched = candidate;
          const flight = flying;
          keep = { text: flight.text, handle: flight.promise?.handle, done: flight.promise!.then(result => result, () => ({ ok: false } as SpeculativeSynthesis)), abort: () => flight.controller.abort() };
        }
      }
      if (flying && !keep) flying.controller.abort();
      buffer = [];
      dispatched = []; sentences = []; failed = false;
      return { wavs, matchedText: matched, remainderText: final.slice(matched.length).trim(), ...(keep ? { inflight: keep } : {}) };
    },
    /** Discards everything and aborts the in-flight synthesis (tool-call turn, abort/retry, toggle off, stop). */
    cancel() { reset(); },
    /** Like `cancel`, permanently (reload, shutdown). */
    dispose() { reset(); disposed = true; },
  };
}
