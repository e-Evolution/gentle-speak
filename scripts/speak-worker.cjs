"use strict";
// Child-only JSON-lines protocol. Parent owns consent, UI, and installation.
const fs = require('node:fs');
const path = require('node:path');
const SCHEMA = 'gentle.speak/v1';
const SHERPA = 'node_modules/sherpa-onnx-node/non-streaming-tts.js';
const CPAL = 'node_modules/node-cpal/index.js';
const MAX_LINE = 16384;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const absolute = p => typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && p.length < 4096;
const safeFile = p => typeof p === 'string' && /^[\w.-]+$/.test(p) && p !== '.' && p !== '..';
function parse(m) {
  if (!exact(m, ['schema', 'type', 'id', 'text', 'speed', 'runtime', 'model']) || m.schema !== SCHEMA || m.type !== 'speak' || !Number.isSafeInteger(m.id) || m.id < 0 || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 4000 || /[\x00-\x1f]/.test(m.text) || typeof m.speed !== 'number' || !Number.isFinite(m.speed) || m.speed < 0.5 || m.speed > 2 || !absolute(m.runtime) || !exact(m.model, ['root', 'name']) || !absolute(m.model.root) || !safeFile(m.model.name) || !m.model.name.endsWith('.onnx')) throw Error('invalid-request');
  return m;
}
const MAX_WAV_BYTES = 64 * 1024 * 1024;
// `play` carries a synthesized PCM16 mono WAV (Qwen chunks); `runtime` locates node-cpal exactly like `speak` does.
function parsePlay(m) {
  if (!exact(m, ['schema', 'type', 'id', 'wav', 'speed', 'runtime']) || m.schema !== SCHEMA || m.type !== 'play' || !Number.isSafeInteger(m.id) || m.id < 0 || !absolute(m.wav) || typeof m.speed !== 'number' || !Number.isFinite(m.speed) || m.speed < 0.5 || m.speed > 2 || !absolute(m.runtime)) throw Error('invalid-request');
  return m;
}
function readWav(file) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_WAV_BYTES) throw Error('wav');
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw Error('wav');
  let at = 12, rate = 0, fmt = false, data;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > b.length) throw Error('wav');
      if (b.readUInt16LE(body) !== 1 || b.readUInt16LE(body + 2) !== 1 || b.readUInt16LE(body + 14) !== 16) throw Error('wav');
      rate = b.readUInt32LE(body + 4); fmt = true;
    } else if (id === 'data') {
      if (!fmt) throw Error('wav');
      // Streaming writers may leave the size unfilled; clamp to the bytes present.
      data = b.subarray(body, Math.min(body + size, b.length)); break;
    }
    at = body + size + (size & 1);
  }
  if (!data || !fmt || rate < 8000 || rate > 384000) throw Error('wav');
  const count = data.length >> 1;
  if (count === 0 || count > rate * 120) throw Error('wav');
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: rate };
}
// Short, bounded, path-free reason for a native playback failure (cpal error message).
function causeOf(error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function runSpeakWorker(io) {
  return new Promise(resolve => {
    let cause, buffer = '', queue = [], active = false, closed = false, epoch = 0, stream, device, host, cancelPlayback, cancelSynthesis;
    const send = (type, fields = {}) => io.write(JSON.stringify({ schema: SCHEMA, type, ...fields }) + '\n');
    const closeStream = () => {
      const old = stream; stream = undefined; try { old?.close(); } catch {}
      const output = device; device = undefined; try { output?.close(); } catch {}
      const owner = host; host = undefined; try { owner?.close(); } catch {}
      const cancel = cancelPlayback; cancelPlayback = undefined; cancel?.();
    };
    const cancelWork = () => { const cancel = cancelSynthesis; cancelSynthesis = undefined; cancel?.(); closeStream(); };
    const finish = code => { if (closed) return; closed = true; epoch++; queue = []; cancelWork(); io.input.off('data', onData); io.input.off('end', onEnd); io.exit(code); resolve(); };
    const fail = code => { send('error', { code }); finish(1); };
    const stop = () => { epoch++; queue = []; cancelWork(); send('stopped'); };
    const run = async () => {
      if (active || closed || !queue.length) return;
      active = true;
      const m = queue.shift(); const token = epoch;
      cause = undefined;
      try {
        // Only load from the explicitly selected installed roots; never on child startup.
        const cpalPath = path.join(m.runtime, CPAL);
        let cpal, audio;
        if (m.type === 'play') {
          if (!fs.statSync(cpalPath).isFile()) throw Error('invalid');
          audio = readWav(m.wav);
          cpal = io.loadModule(cpalPath);
        } else {
        const ttsPath = path.join(m.runtime, SHERPA);
        const modelPath = path.join(m.model.root, m.model.name);
        const tokens = path.join(m.model.root, 'tokens.txt');
        const dataDir = path.join(m.model.root, 'espeak-ng-data');
        for (const p of [ttsPath, cpalPath, modelPath, tokens]) if (!fs.statSync(p).isFile()) throw Error('invalid');
        if (!fs.statSync(dataDir).isDirectory()) throw Error('invalid');
        const { OfflineTts } = io.loadModule(ttsPath);
        cpal = io.loadModule(cpalPath);
        const tts = new OfflineTts({ model: { vits: { model: modelPath, tokens, dataDir, lengthScale: 1 / m.speed } }, numThreads: 2, provider: 'cpu' });
        // Native synthesis may never settle; cancellation releases the queue and ignores late results.
        audio = await Promise.race([
          Promise.resolve().then(() => tts.generateAsync({ text: m.text, sid: 0, speed: m.speed })),
          new Promise(resolve => { cancelSynthesis = () => resolve(undefined); }),
        ]);
        cancelSynthesis = undefined;
        if (token !== epoch || closed) return;
        }
        if (!(audio?.samples instanceof Float32Array) || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 384000 || audio.samples.length === 0 || audio.samples.length > audio.sampleRate * 120) throw Error('audio');
        host = cpal.defaultHost();
        try {
          device = host.defaultOutputDevice();
          if (!device) throw Error('device');
          // Open the device's own default config so CoreAudio is never asked to change its sample rate
          // (Bluetooth devices time out on that); the audio is resampled to it below.
          const searchConfig = () => {
            const supported = [...device.supportedOutputConfigs()].filter(c => c.sampleFormat() === cpal.SampleFormat.F32);
            // Prefer the model rate; otherwise choose a common F32 device rate.
            const atRate = rate => supported.map(c => c.containsRate(rate) ? c.tryWithSampleRate(rate) : null).find(Boolean);
            return atRate(audio.sampleRate) || atRate(48000) || atRate(44100) ||
              supported.map(c => c.tryWithStandardSampleRate?.()).find(Boolean) ||
              supported.map(c => c.withMaxSampleRate?.()).find(Boolean);
          };
          let chosen, usedDefault = false, started = false;
          try {
            const current = device.defaultOutputConfig?.();
            if (current && current.sampleFormat() === cpal.SampleFormat.F32) { chosen = current; usedDefault = true; }
          } catch {}
          if (!chosen) chosen = searchConfig();
          const playWith = async candidate => {
          const config = candidate?.config();
          if (!config || !Number.isSafeInteger(config.channels) || config.channels < 1 || config.channels > 8 ||
              !Number.isSafeInteger(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 96000) throw Error('format');
          const frames = Math.round(audio.samples.length * config.sampleRate / audio.sampleRate);
          if (frames < 1 || frames > config.sampleRate * 120) throw Error('format');
          let at = 0, submitted = false;
          await new Promise((resolvePlayback, rejectPlayback) => {
            let settled = false;
            const settle = error => { if (settled) return; settled = true; clearTimeout(timer); cancelPlayback = undefined; error ? rejectPlayback(error) : resolvePlayback(); };
            const timer = setTimeout(() => settle(Error('timeout')), Math.ceil(frames / config.sampleRate * 1000) + 3000);
            cancelPlayback = () => settle();
            try {
            stream = device.buildOutputStream(config, cpal.SampleFormat.F32, data => {
              started = true;
              data.fill(0);
              if (token !== epoch || closed) return settle();
              for (let i = 0; i < data.length; i += config.channels) {
                if (at >= frames) break;
                const position = at++ * audio.sampleRate / config.sampleRate;
                const from = Math.min(Math.floor(position), audio.samples.length - 1);
                const next = Math.min(from + 1, audio.samples.length - 1);
                const value = audio.samples[from] + (audio.samples[next] - audio.samples[from]) * (position - from);
                for (let c = 0; c < config.channels; c++) data[i + c] = value;
              }
              // A subsequent callback indicates the final submitted buffer was consumed.
              if (submitted) settle();
              submitted = at >= frames;
            }, error => { cause = causeOf(error); settle(error || Error('stream')); });
            stream.play();
            } catch (error) { cause = causeOf(error); throw error; }
          });
          };
          try { await playWith(chosen); }
          catch (error) {
            // The device default config may be refused (e.g. a sample-rate change): try the supported-config search once.
            if (!usedDefault || started || token !== epoch || closed) throw error;
            const old = stream; stream = undefined; try { old?.close(); } catch {}
            await playWith(searchConfig());
          }
        } finally { closeStream(); }
        if (token === epoch && !closed) send('done', { id: m.id });
      } catch { if (token === epoch && !closed) send('error', { code: 'playback', id: m.id, ...(cause ? { cause } : {}) }); }
      finally { active = false; if (!closed) void run(); }
    };
    const dispatch = m => {
      if (exact(m, ['schema', 'type']) && m.schema === SCHEMA && m.type === 'shutdown') return finish(0);
      if (exact(m, ['schema', 'type']) && m.schema === SCHEMA && m.type === 'stop') return stop();
      let request;
      try { request = m && m.type === 'play' ? parsePlay(m) : parse(m); } catch { return fail('invalid-request'); }
      if (queue.length >= (request.type === 'play' ? 64 : 3)) return send('error', { code: 'queue-full', id: request.id });
      queue.push(request); void run();
    };
    const onData = chunk => {
      buffer += String(chunk);
      if (buffer.length > MAX_LINE * 4) return fail('invalid-request');
      let index;
      while (!closed && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.length > MAX_LINE) return fail('invalid-request');
        try { dispatch(JSON.parse(line)); } catch { fail('invalid-request'); }
      }
      if (buffer.length > MAX_LINE) fail('invalid-request');
    };
    const onEnd = () => finish(0);
    io.input.on('data', onData); io.input.on('end', onEnd);
  });
}
module.exports = { runSpeakWorker };
if (require.main === module) {
  process.stdin.setEncoding('utf8');
  runSpeakWorker({ input: process.stdin, write: line => process.stdout.write(line), exit: code => process.stdout.write('', () => process.exit(code)), loadModule: p => require(p) });
}
