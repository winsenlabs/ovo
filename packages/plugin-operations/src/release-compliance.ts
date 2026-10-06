import {
  callingWindowSchema,
  resolveCallingWindow,
  type CallingWindow,
  type CallingWindowInput,
} from './calling-window.ts';

/** The agent's timezone when its config names none (the AgentConfig default). */
const AGENT_DEFAULT_TIMEZONE = 'Asia/Kolkata';

export class CompliancePolicyError extends Error {}

/**
 * The calling window a release declares (`compliance.callingHours`), judged in its own timezone or
 * else the agent's. Read structurally from the immutable config, so a release published before the
 * contract carried compliance simply has none. A malformed block fails closed: no window is
 * guessed for a release that asked for one.
 */
export function releaseCallingWindow(config: unknown): CallingWindow | undefined {
  const agent = (config ?? {}) as { timezone?: unknown; compliance?: { callingHours?: unknown } };
  const declared = agent.compliance?.callingHours;
  if (declared === undefined || declared === null) return undefined;
  const parsed = callingWindowSchema.safeParse(declared);
  if (!parsed.success) throw new CompliancePolicyError('Release calling hours are invalid');
  return resolveRelease(parsed.data, agent.timezone);
}

function resolveRelease(window: CallingWindowInput, timezone: unknown): CallingWindow {
  try {
    return resolveCallingWindow(
      window,
      typeof timezone === 'string' && timezone ? timezone : AGENT_DEFAULT_TIMEZONE,
    );
  } catch {
    throw new CompliancePolicyError('Release calling hours name an unknown timezone');
  }
}
