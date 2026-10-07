import { createHash } from 'node:crypto';
import type {
  CampaignConsentBasis,
  CapPolicy,
  ComplianceCategory,
  CompliancePurpose,
  ComplianceRefusalCode,
  WindowRule,
  WindowSet,
  WorkspaceCompliance,
} from '@winsendotai/ovo-contracts';
import type { RulePack } from './rule-packs.ts';
import { neverOpen, widens, type WindowLayer } from './windows.ts';

/** What a campaign snapshots at create: the agent's and the campaign's own compliance choices. */
export interface CompliancePolicy {
  version: 1;
  category?: ComplianceCategory;
  purpose?: CompliancePurpose;
  consentBasis?: CampaignConsentBasis;
  consentScope?: { principalEntity?: string; purpose?: string };
  agentWindow?: { rules: WindowRule[]; timezone: string };
  campaignWindow?: { rules: WindowRule[]; timezone: string };
  caps?: CapPolicy;
  scrubMaxAgeHours?: number;
  /** A live or test call: its window is judged when it is requested, never requeued for later. */
  manual?: boolean;
}

export interface ResolvedCaps {
  attempts: { per24h?: number; per7d?: number; per30d?: number };
  connected: { per24h?: number; per7d?: number };
  minGapMinutes?: number;
}

type DefaultKey = ComplianceCategory | 'rbi_recovery';

const ALL_WEEK: WindowRule[] = [{ start: '00:00', end: '23:59' }];
/** [BP] defaults inside the floors (spec 3.2 table); the workspace settings may change them. */
export const DEFAULT_WINDOWS: Readonly<Record<DefaultKey, WindowRule[]>> = Object.freeze({
  promotional: [{ days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '21:00' }],
  service: [{ start: '09:00', end: '20:00' }],
  rbi_recovery: [{ start: '09:00', end: '19:00' }],
  transactional: ALL_WEEK,
});
export const DEFAULT_CAPS: Readonly<Record<DefaultKey, ResolvedCaps>> = Object.freeze({
  promotional: {
    attempts: { per24h: 1, per7d: 2, per30d: 4 },
    connected: { per24h: 1, per7d: 1 },
    minGapMinutes: 1_440,
  },
  service: { attempts: { per24h: 3, per7d: 10 }, connected: { per24h: 1 }, minGapMinutes: 120 },
  // Q4: 3 attempts and 1 conversation a day, as evidence of RBI's no-harassment rule (R17).
  rbi_recovery: {
    attempts: { per24h: 3, per7d: 12 },
    connected: { per24h: 1 },
    minGapMinutes: 120,
  },
  transactional: { attempts: { per24h: 3 }, connected: {} },
});

export function defaultKey(policy: Pick<CompliancePolicy, 'category' | 'purpose'>): DefaultKey {
  if (policy.purpose === 'rbi_recovery' && policy.category !== 'promotional') return 'rbi_recovery';
  return policy.category ?? 'service';
}

/** Every layer a recipient's window is judged against, in the pack's recipient timezone if any. */
export function windowLayers(
  pack: RulePack,
  settings: WorkspaceCompliance,
  policy: CompliancePolicy,
): WindowLayer[] {
  const tz = (own: string) => pack.recipientTimezone ?? own;
  const layers: WindowLayer[] = [];
  if (pack.categories) {
    const key = defaultKey(policy);
    const floor = pack.categories[policy.category ?? 'service'].window;
    if (floor) layers.push({ source: 'rule_pack', timezone: tz('UTC'), rules: [floor] });
    const overlay = policy.purpose ? pack.purposeOverlays[policy.purpose] : undefined;
    if (overlay) layers.push({ source: 'purpose', timezone: tz('UTC'), rules: [overlay.window] });
    const blackout = settings.blackout.appliesTo.some(
      (kind) => kind === key || kind === (policy.category ?? 'service'),
    );
    layers.push({
      source: 'workspace',
      timezone: tz('UTC'),
      rules:
        (settings.windows[key] ?? settings.windows[policy.category ?? 'service'])?.rules ??
        DEFAULT_WINDOWS[key],
      ...(blackout ? { blackout: settings.blackout.dates } : {}),
    });
  } else if (settings.windows.generic) {
    const generic: WindowSet = settings.windows.generic;
    layers.push({ source: 'workspace', timezone: generic.timezone ?? 'UTC', rules: generic.rules });
  }
  if (policy.agentWindow)
    layers.push({
      source: 'agent',
      timezone: tz(policy.agentWindow.timezone),
      rules: policy.agentWindow.rules,
    });
  if (policy.campaignWindow)
    layers.push({
      source: 'campaign',
      timezone: tz(policy.campaignWindow.timezone),
      rules: policy.campaignWindow.rules,
    });
  return layers;
}

function lowest(...values: (number | undefined)[]): number | undefined {
  const set = values.filter((value): value is number => value !== undefined);
  return set.length ? Math.min(...set) : undefined;
}

function narrow(base: ResolvedCaps, next: CapPolicy | ResolvedCaps | undefined): ResolvedCaps {
  if (!next) return base;
  return {
    attempts: {
      per24h: lowest(base.attempts.per24h, next.attempts?.per24h),
      per7d: lowest(base.attempts.per7d, next.attempts?.per7d),
      per30d: lowest(base.attempts.per30d, next.attempts?.per30d),
    },
    connected: {
      per24h: lowest(base.connected.per24h, next.connected?.per24h),
      per7d: lowest(base.connected.per7d, next.connected?.per7d),
    },
    minGapMinutes:
      base.minGapMinutes === undefined || next.minGapMinutes === undefined
        ? (next.minGapMinutes ?? base.minGapMinutes)
        : Math.max(base.minGapMinutes, next.minGapMinutes),
  };
}

const NO_CAPS: ResolvedCaps = { attempts: {}, connected: {} };

/** Per-recipient caps: the workspace's (or the [BP] default), narrowed by the campaign's. */
export function resolveCaps(
  pack: RulePack,
  settings: WorkspaceCompliance,
  policy: CompliancePolicy,
): ResolvedCaps {
  if (!pack.categories) return narrow(narrow(NO_CAPS, settings.caps.generic), policy.caps);
  const key = defaultKey(policy);
  const configured = settings.caps[key] ?? settings.caps[policy.category ?? 'service'];
  let caps = configured ? narrow(NO_CAPS, configured) : DEFAULT_CAPS[key];
  if (key === 'rbi_recovery' && settings.enforcement.recoveryCapsAreFloor)
    caps = narrow(caps, DEFAULT_CAPS.rbi_recovery);
  return narrow(caps, policy.caps);
}

/** The consent basis a campaign relies on when it names none; promotional must name one. */
export function consentBasisFor(policy: CompliancePolicy): CampaignConsentBasis | undefined {
  if (policy.consentBasis) return policy.consentBasis;
  if (policy.category === 'service') return 'inferred_relationship';
  if (policy.category === 'transactional') return 'transaction_30min';
  return undefined;
}

export type PolicyProblem = { code: ComplianceRefusalCode; message: string; source?: string };

/**
 * Write-time checks (stage E1): a +91 campaign needs a category and an allowed consent basis, no
 * window may widen the floor or the agent's window, and the windows must open at some point.
 */
export function policyProblems(
  pack: RulePack,
  settings: WorkspaceCompliance,
  policy: CompliancePolicy,
  options: { requireCategory: boolean },
): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (pack.categories && options.requireCategory) {
    if (!policy.category)
      return [{ code: 'category_missing', message: 'Set the agent call category first' }];
    const basis = consentBasisFor(policy);
    if (!basis || !pack.categories[policy.category].consent.includes(basis))
      problems.push({
        code: 'consent_basis_not_allowed',
        message: `${basis ?? 'No consent basis'} is not allowed for ${policy.category} calls`,
      });
    if (policy.category === 'promotional' && !settings.scrub.provider)
      problems.push({ code: 'scrub_provider_missing', message: 'Configure a DND scrub provider' });
  }
  const layers = windowLayers(pack, settings, policy);
  const floors = layers.filter(
    (layer) => layer.source === 'rule_pack' || layer.source === 'purpose',
  );
  for (const source of ['agent', 'campaign'] as const) {
    const layer = layers.find((candidate) => candidate.source === source);
    const bounds = source === 'campaign' ? layers.filter((l) => l.source === 'agent') : [];
    if (layer && widens(layer, [...floors, ...bounds]))
      problems.push({
        code: 'policy_widens_floor',
        message: `The ${source} calling window is wider than the window it must stay inside`,
        source,
      });
  }
  if (!problems.length && layers.length && neverOpen(layers))
    problems.push({ code: 'calling_window_empty', message: 'The calling windows never overlap' });
  return problems;
}

/** A short, stable hash of everything a decision was judged under. */
export function policyHash(pack: RulePack, settingsVersion: number, policy: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ pack: `${pack.id}@${pack.version}`, settingsVersion, policy }))
    .digest('hex')
    .slice(0, 16);
}
