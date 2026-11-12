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
  env: { PI_CODING_AGENT_DIR: join(home, 'terminal-agent'), GENTLE_DOT_AGENT_HOME: join(home, 'dot-agent'), GENTLE_DOT_HOME: join(home, 'dot-home') } as Record<string, string | undefined>,
});
