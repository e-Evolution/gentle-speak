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
function runSpeakWorker(io) {
  return new Promise(resolve => {
    let buffer = '', queue = [], active = false, closed = false, epoch = 0, stream, device, host, cancelPlayback, cancelSynthesis;
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
      try {
        // Only load from the explicitly selected installed roots; never on child startup.
        const ttsPath = path.join(m.runtime, SHERPA), cpalPath = path.join(m.runtime, CPAL);
        const modelPath = path.join(m.model.root, m.model.name);
        const tokens = path.join(m.model.root, 'tokens.txt');
        const dataDir = path.join(m.model.root, 'espeak-ng-data');
        for (const p of [ttsPath, cpalPath, modelPath, tokens]) if (!fs.statSync(p).isFile()) throw Error('invalid');
        if (!fs.statSync(dataDir).isDirectory()) throw Error('invalid');
        const { OfflineTts } = io.loadModule(ttsPath);
        const cpal = io.loadModule(cpalPath);
        const tts = new OfflineTts({ model: { vits: { model: modelPath, tokens, dataDir, lengthScale: 1 / m.speed } }, numThreads: 2, provider: 'cpu' });
        // Native synthesis may never settle; cancellation releases the queue and ignores late results.
        const audio = await Promise.race([
          Promise.resolve().then(() => tts.generateAsync({ text: m.text, sid: 0, speed: m.speed })),
          new Promise(resolve => { cancelSynthesis = () => resolve(undefined); }),
        ]);
        cancelSynthesis = undefined;
        if (token !== epoch || closed) return;
        if (!(audio?.samples instanceof Float32Array) || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 384000 || audio.samples.length === 0 || audio.samples.length > audio.sampleRate * 120) throw Error('audio');
        host = cpal.defaultHost();
        try {
          device = host.defaultOutputDevice();
          if (!device) throw Error('device');
          const supported = [...device.supportedOutputConfigs()].filter(c => c.sampleFormat() === cpal.SampleFormat.F32);
          // Prefer the model rate; otherwise choose a common F32 device rate.
          const atRate = rate => supported.map(c => c.containsRate(rate) ? c.tryWithSampleRate(rate) : null).find(Boolean);
          const chosen = atRate(audio.sampleRate) || atRate(48000) || atRate(44100) ||
            supported.map(c => c.tryWithStandardSampleRate?.()).find(Boolean) ||
            supported.map(c => c.withMaxSampleRate?.()).find(Boolean);
          const config = chosen?.config();
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
            stream = device.buildOutputStream(config, cpal.SampleFormat.F32, data => {
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
            }, settle);
            stream.play();
          });
        } finally { closeStream(); }
        if (token === epoch && !closed) send('done', { id: m.id });
      } catch { if (token === epoch && !closed) send('error', { code: 'playback', id: m.id }); }
      finally { active = false; if (!closed) void run(); }
    };
    const dispatch = m => {
      if (exact(m, ['schema', 'type']) && m.schema === SCHEMA && m.type === 'shutdown') return finish(0);
      if (exact(m, ['schema', 'type']) && m.schema === SCHEMA && m.type === 'stop') return stop();
      let request;
      try { request = parse(m); } catch { return fail('invalid-request'); }
      if (queue.length >= 3) return send('error', { code: 'queue-full', id: request.id });
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
