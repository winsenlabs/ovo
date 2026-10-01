import type {
  CarrierIngress,
  CarrierMediaEvent,
  Clock,
  CompatIssue,
  EngineEvent,
  EngineOutcome,
  FixtureTemplate,
  NetFixtureScript,
  UsageMeter,
} from '@winsendotai/ovo-contracts';
import type {
  PluginRegistry,
  ParentView,
  InstalledSessionExtensions,
} from '@winsendotai/ovo-runtime';
import type { SessionDefaults, SessionGraphRelease } from '@winsendotai/ovo-session-host';

export interface CallerScript {
  turns: readonly { atMs: number; say?: string; dtmf?: string; silenceMs?: number }[];
}

export interface FixtureRecordingWriter {
  write(track: 'caller' | 'agent', bytes: Uint8Array, atMs: number): void | Promise<void>;
  finish(outcome: EngineOutcome): Promise<unknown> | unknown;
}

export interface FixtureCallInput {
  /** Allocated by the API before execution so the durable row and stream share one identity. */
  callId?: string;
  release?: SessionGraphRelease;
  draft?: SessionGraphRelease;
  registry: PluginRegistry;
  fixtures: Readonly<Record<string, NetFixtureScript[]>>;
  fixtureTemplates: Readonly<Record<string, FixtureTemplate>>;
  /** Synthetic, test-only credential IDs; never read the live secret resolver. */
  fixtureSecrets?: Readonly<Record<string, string>>;
  /** Selected carrier ingress, obtained from the process graph, never a replacement serializer. */
  carrier: {
    pluginId: string;
    ingress: CarrierIngress;
    /** Provider-specific inbound frame fixture paired with the selected real serializer. */
    inboundFrame(event: CarrierMediaEvent): string;
  };
  callerScript?: CallerScript | 'default';
  clock?: Clock;
  defaults?: SessionDefaults;
  parent?: ParentView;
  installedExtensions?: InstalledSessionExtensions;
  agentTexts?: readonly string[];
  telemetry?: {
    onEvent?(event: FixtureCallEvent): void | Promise<void>;
    onUsage?(meter: UsageMeter): void | Promise<void>;
  };
  /** Opening a recording row is delayed until after config.recording has been checked. */
  recording?: { open(callId: string): Promise<FixtureRecordingWriter> | FixtureRecordingWriter };
}

export interface FixtureCallEvent {
  seq: number;
  atMs: number;
  event: EngineEvent;
}

export interface FixtureCallResult {
  callId: string;
  kind: 'test';
  status: 'completed' | 'failed';
  outcome: EngineOutcome;
  events: FixtureCallEvent[];
  compatIssues: CompatIssue[];
  selections: Record<string, { id: string; version: string; exact: boolean }>;
  sttMode: 'template' | 'static' | 'fixture-generic' | 'none';
  usage: UsageMeter[];
  carrierFrames: string[];
  recording?: unknown;
}
