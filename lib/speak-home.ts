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
import * as os from 'node:os';
import { isAbsolute, join } from 'node:path';

// S12: Gentle Dot's engine runs with `HOME` overridden (its own `~/.gentle-dot/home`), so `os.homedir()` (which honors `$HOME`)
// would resolve every user-level path under the wrong tree. The account's home comes from the passwd entry instead.
export interface HomeIo { userInfo?: () => { homedir: string }; homedir?: () => string }

/** The account's real home: `os.userInfo().homedir` when it is a non-empty absolute path, else `os.homedir()`. */
export function realHome(io: HomeIo = {}): string {
  try {
    const home = (io.userInfo ?? os.userInfo)().homedir;
    if (typeof home === 'string' && home !== '' && isAbsolute(home)) return home;
  } catch { /* no passwd entry: fall back */ }
  return (io.homedir ?? os.homedir)();
}

/** T35: the process's `$HOME` (`os.homedir()`); inside Gentle Dot it is Dot's own home. Together with `realHome()` the only places a real user path is derived. */
export const processHome = (io: HomeIo = {}): string => (io.homedir ?? os.homedir)();

const SPEAK_DIR = '.gentle-speak';
/** T34: where this process keeps `speak-settings.json` and per-app state: `<$HOME>/.gentle-speak` (Dot's HOME is its own `<dataDir>/home`). */
export const settingsHome = (io: HomeIo = {}): string => join(processHome(io), SPEAK_DIR);
/** T34: what every app shares (runtime, Piper models, Qwen voices and manifests, the voice lock, the Qwen child's HOME): `<real home>/.gentle-speak`. In a terminal it equals `settingsHome()`. */
export const sharedHome = (io: HomeIo = {}): string => join(realHome(io), SPEAK_DIR);
