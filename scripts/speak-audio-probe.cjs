/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
"use strict";
// T44 doctor probe: opens the default output device with a silent stream (all zero samples) and closes it. One JSON line on stdout, no sound.
// argv[2] is the installed runtime root. The parent bounds the run with a timeout and kills it.
const path = require('node:path');
const done = (value) => { process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(value.ok ? 0 : 1)); };
const text = (error) => String(error && error.message || error || 'error').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
try {
  const root = process.argv[2];
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('invalid runtime');
  const cpal = require(path.join(root, 'node_modules/node-cpal/index.js'));
  const host = cpal.defaultHost();
  const device = host.defaultOutputDevice();
  if (!device) throw Error('no default output device');
  const current = device.defaultOutputConfig();
  if (!current) throw Error('no default output config');
  const config = current.config();
  const stream = device.buildOutputStream(config, cpal.SampleFormat.F32, data => { data.fill(0); }, () => {});
  stream.play();
  setTimeout(() => {
    try { stream.close(); } catch {}
    try { device.close(); } catch {}
    try { host.close(); } catch {}
    done({ ok: true, rate: config.sampleRate, channels: config.channels });
  }, 120);
} catch (error) { done({ ok: false, message: text(error) }); }
