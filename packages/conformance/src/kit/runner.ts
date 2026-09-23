/**
 * One kit invariant. `run` returns failure messages (or throws); an empty list passes. `signal`
 * is aborted when the check times out, so a check can tear its fixtures down (#F26).
 */
export interface KitCheck<C> {
  name: string;
  run(context: C, signal: AbortSignal): Promise<readonly string[] | void>;
  /** Per-check timeout in ms (default 15 s). */
  timeoutMs?: number;
}

export interface KitFailure {
  check: string;
  message: string;
}

export interface KitRunOptions {
  /** Run only checks whose name includes one of these substrings. */
  only?: readonly string[];
  timeoutMs?: number;
}

export function selectChecks<C>(
  checks: readonly KitCheck<C>[],
  only?: readonly string[],
): KitCheck<C>[] {
  return only?.length
    ? checks.filter((check) => only.some((part) => check.name.includes(part)))
    : [...checks];
}

/** Runs one check against a fresh context and returns its failures (never throws). */
export async function runCheck<C>(
  check: KitCheck<C>,
  context: () => C | Promise<C>,
  timeoutMs = 15_000,
): Promise<KitFailure[]> {
  const ms = check.timeoutMs ?? timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => check.run(await context(), controller.signal))();
  // The abandoned work is aborted and its rejection swallowed, so nothing leaks past the deadline.
  work.catch(() => undefined);
  try {
    const messages = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`${check.name} timed out after ${ms} ms`));
          reject(new Error(`${check.name} timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
    return (messages ?? []).map((message) => ({ check: check.name, message }));
  } catch (error) {
    return [{ check: check.name, message: error instanceof Error ? error.message : String(error) }];
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every (selected) check sequentially; used by the `checkX` meta-testing entry points. */
export async function runChecks<C>(
  checks: readonly KitCheck<C>[],
  context: () => C | Promise<C>,
  options: KitRunOptions = {},
): Promise<KitFailure[]> {
  const failures: KitFailure[] = [];
  for (const check of selectChecks(checks, options.only))
    failures.push(...(await runCheck(check, context, options.timeoutMs)));
  return failures;
}

/** Collects failure messages; `expect` returns whether the condition held. */
export class Failures {
  readonly messages: string[] = [];
  expect(condition: unknown, message: string): boolean {
    if (!condition) this.messages.push(message);
    return Boolean(condition);
  }
  add(...messages: string[]): void {
    this.messages.push(...messages);
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Usage emitted exactly once per unit, each meter with a requestId (and the expected operation). */
export function usageFailures(
  usage: readonly { unit: string; requestId: string; operation: string }[],
  when: string,
  operation?: string,
): string[] {
  const f = new Failures();
  f.expect(usage.length > 0, `${when}: no usage was emitted`);
  const units = new Map<string, number>();
  for (const meter of usage) units.set(meter.unit, (units.get(meter.unit) ?? 0) + 1);
  for (const [unit, count] of units)
    f.expect(count === 1, `${when}: usage ${unit} emitted ${count} times`);
  for (const meter of usage) {
    f.expect(Boolean(meter.requestId), `${when}: usage without requestId`);
    if (operation)
      f.expect(meter.operation === operation, `${when}: usage operation is ${meter.operation}`);
  }
  return f.messages;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
