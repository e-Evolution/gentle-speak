import { join } from 'node:path';

/** S12: injected HOME, terminal agent dir and Dot home for an extension harness, so no test reads or writes the real user's paths. */
export const hermetic = (home: string) => ({ userHome: home, env: { PI_CODING_AGENT_DIR: join(home, 'terminal-agent'), GENTLE_DOT_AGENT_HOME: join(home, 'dot-agent') } as Record<string, string | undefined> });
