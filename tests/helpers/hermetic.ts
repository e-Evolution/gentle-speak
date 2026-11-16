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
import { join } from 'node:path';

/**
 * S12, T35: every real-path input of an extension harness, injected: the account home (`userHome`, what `realHome()` yields), the process home
 * (`processHome`, what `$HOME` yields), the terminal agent dir and Dot's agent dir and home. Nothing falls back to the real user's paths;
 * tests/helpers/guard-real-home.ts fails the run if anything does. Spread it first and override what a test needs.
 */
export const hermetic = (home: string) => ({
  userHome: home,
  processHome: home,
  /** T44: the first-start setup offer probes PATH tools; tests that are not about it keep it off (its own tests turn it on with fakes). */
  setupOffer: false,
  /**
   * T62: the host platform is an input too. The default is macOS (the platform these wiring tests describe), so a Linux or Windows CI host runs
   * the same checks; a test about another platform overrides it after the spread.
   */
  platform: 'darwin',
  env: { PI_CODING_AGENT_DIR: join(home, 'terminal-agent'), GENTLE_DOT_AGENT_HOME: join(home, 'dot-agent'), GENTLE_DOT_HOME: join(home, 'dot-home') } as Record<string, string | undefined>,
});
