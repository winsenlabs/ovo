import type { WindowRule } from '@winsendotai/ovo-contracts';
import { callingWindowState, localParts, type LocalParts } from '../calling-window.ts';
import { resolveScheduledInstant, ScheduleTimeError } from '../timezone.ts';

/**
 * Calling windows as layers (compliance spec 3.2): the rule-pack floor, the purpose overlay, the
 * workspace default, the agent and the campaign. A call may be placed only when every layer is
 * open, so configuration can only ever narrow the floor (G4).
 */
export interface WindowLayer {
  source: 'rule_pack' | 'purpose' | 'workspace' | 'agent' | 'campaign';
  timezone: string;
  rules: readonly WindowRule[];
  /** Local dates with no calls: `YYYY-MM-DD`, or `MM-DD` every year. */
  blackout?: readonly string[];
}

export type LayersState =
  { open: true } | { open: false; nextOpenAt: Date } | { open: false; never: true };

const DAY_MS = 86_400_000;
const HORIZON_MS = 15 * DAY_MS;
const pad = (value: number) => String(value).padStart(2, '0');

function dateOf(local: LocalParts): string {
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

function blackedOut(layer: WindowLayer, local: LocalParts): boolean {
  if (!layer.blackout?.length) return false;
  const date = dateOf(local);
  return layer.blackout.includes(date) || layer.blackout.includes(date.slice(5));
}

function ruleOpen(rule: WindowRule, local: LocalParts): boolean {
  const minute = `${pad(local.hour)}:${pad(local.minute)}`;
  return (
    (!rule.days || rule.days.includes(local.weekday)) && minute >= rule.start && minute < rule.end
  );
}

export function layerOpen(layer: WindowLayer, instant: Date): boolean {
  const local = localParts(instant, layer.timezone);
  return !blackedOut(layer, local) && layer.rules.some((rule) => ruleOpen(rule, local));
}

function nextLocalMidnight(local: LocalParts, timezone: string): Date {
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const date = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  for (const time of ['00:00', '01:00', '02:00']) {
    try {
      return resolveScheduledInstant(`${date}T${time}`, timezone);
    } catch (error) {
      if (!(error instanceof ScheduleTimeError)) throw error;
    }
  }
  return new Date(Date.parse(`${date}T00:00Z`));
}

/** The first instant at or after `instant` the layer is open, skipping blackout days. */
export function layerNextOpen(layer: WindowLayer, instant: Date): Date | undefined {
  let from = instant;
  for (let hop = 0; hop < 32; hop += 1) {
    let best: Date | undefined;
    for (const rule of layer.rules) {
      const state = callingWindowState({ ...rule, timezone: layer.timezone }, from);
      const at = state.open ? from : state.nextOpenAt;
      if (!best || at.getTime() < best.getTime()) best = at;
    }
    if (!best) return undefined;
    const local = localParts(best, layer.timezone);
    if (!blackedOut(layer, local)) return best;
    from = nextLocalMidnight(local, layer.timezone);
  }
  return undefined;
}

/** Whether every layer is open at `now`, and if not the first instant they all are. */
export function layersState(layers: readonly WindowLayer[], now = new Date()): LayersState {
  let at = now;
  for (let step = 0; step < 200; step += 1) {
    const closed = layers.filter((layer) => !layerOpen(layer, at));
    if (!closed.length)
      return at.getTime() === now.getTime() ? { open: true } : { open: false, nextOpenAt: at };
    let next = at;
    for (const layer of closed) {
      const opens = layerNextOpen(layer, at);
      if (!opens) return { open: false, never: true };
      if (opens.getTime() > next.getTime()) next = opens;
    }
    if (next.getTime() <= at.getTime() || next.getTime() - now.getTime() > HORIZON_MS)
      return { open: false, never: true };
    at = next;
  }
  return { open: false, never: true };
}

/** A Monday in a month without daylight-saving changes in India, Europe or the Americas. */
const REFERENCE_WEEK = Date.UTC(2026, 0, 5);
const WEEK_MINUTES = 7 * 1440;
const minuteOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** The minutes of a local week a layer is open (blackouts aside), Monday 00:00 first. */
function weekMask(layer: WindowLayer): Uint8Array {
  const mask = new Uint8Array(WEEK_MINUTES);
  for (const rule of layer.rules)
    for (const day of rule.days ?? [1, 2, 3, 4, 5, 6, 7])
      mask.fill(1, (day - 1) * 1440 + minuteOf(rule.start), (day - 1) * 1440 + minuteOf(rule.end));
  return mask;
}

/**
 * Whether some minute of the week passes `test`. Layers in one timezone (always, for +91 numbers)
 * are compared as local-week masks; mixed timezones are sampled minute by minute over a real week.
 */
function anyMinuteOfWeek(
  layers: readonly WindowLayer[],
  test: (open: (layer: WindowLayer) => boolean) => boolean,
): boolean {
  if (new Set(layers.map((layer) => layer.timezone)).size <= 1) {
    const masks = new Map(layers.map((layer) => [layer, weekMask(layer)]));
    for (let minute = 0; minute < WEEK_MINUTES; minute += 1)
      if (test((layer) => masks.get(layer)![minute] === 1)) return true;
    return false;
  }
  for (let minute = 0; minute < WEEK_MINUTES; minute += 1) {
    const instant = new Date(REFERENCE_WEEK + minute * 60_000);
    if (test((layer) => layerOpen(layer, instant))) return true;
  }
  return false;
}

const withoutBlackout = (layer: WindowLayer): WindowLayer => ({ ...layer, blackout: undefined });

/** True when `inner` is open at some minute of the week that one of `outer` is not (G4). */
export function widens(inner: WindowLayer, outer: readonly WindowLayer[]): boolean {
  const bounds = outer.map(withoutBlackout);
  const plain = withoutBlackout(inner);
  return anyMinuteOfWeek(
    [plain, ...bounds],
    (open) => open(plain) && bounds.some((layer) => !open(layer)),
  );
}

/** True when no minute of the week has every layer open. */
export function neverOpen(layers: readonly WindowLayer[]): boolean {
  const plain = layers.map(withoutBlackout);
  return !anyMinuteOfWeek(plain, (open) => plain.every((layer) => open(layer)));
}

/** The layers as the console and decisions show them. */
export function describeLayers(layers: readonly WindowLayer[]) {
  return layers.map((layer) => ({
    source: layer.source,
    timezone: layer.timezone,
    rules: layer.rules.map((rule) => ({ ...rule })),
    ...(layer.blackout?.length ? { blackout: [...layer.blackout] } : {}),
  }));
}
