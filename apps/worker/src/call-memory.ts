import {
  DISCLOSURE_KINDS,
  type DisclosureKind,
  type EngineEvent,
  type EventSink,
} from '@winsendotai/ovo-contracts';

/** The transcript lines kept per call for handovers: enough for the largest handover policy. */
const MAX_LINES = 48;
const MAX_LINE_CHARS = 500;

export interface TranscriptLine {
  role: 'caller' | 'agent';
  text: string;
}

/** One segment of the call as transfers see it (transfer design 7.1). */
export interface SegmentHistoryEntry {
  index: number;
  role: 'router' | 'agent' | 'human';
  agentId: string;
  releaseId: string;
  poolId?: string;
  memberId?: string;
  claimId?: string;
  language?: string;
  transfer?: number;
  /** Human only: `agentId` is `queue:<key>` and `releaseId` the queue's id. */
  ticketId?: string;
  operatorId?: string;
  queueKind?: 'external' | 'managed';
  startedAt: number;
}

export interface RouteMemory {
  path: string[];
  language?: string;
  context: Record<string, string>;
}

type Transcript = Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>;

/**
 * What one routed call remembers across its segments, in worker memory only (transfer design 7.1,
 * 7.9): the values its behaviours captured, the disclosure kinds the caller heard in full, the
 * route the router decided, the caller's and agents' recent lines (an agent line cut short counts
 * as far as it was heard), and every segment so far. Nothing here is logged, evented or stored.
 */
export class CallMemory {
  readonly captured: Record<string, unknown> = {};
  readonly disclosed = new Set<DisclosureKind>();
  readonly segments: SegmentHistoryEntry[] = [];
  route?: RouteMemory;
  private readonly lines: TranscriptLine[] = [];

  /** Taps a segment's outcome events on their way to the call's sink. */
  observe(type: string, payload: Record<string, unknown>): void {
    if (type === 'variables.captured') {
      const variables = payload.variables;
      if (variables && typeof variables === 'object' && !Array.isArray(variables))
        Object.assign(this.captured, variables);
    } else if (type === 'disclosure' && Array.isArray(payload.kinds)) {
      for (const kind of payload.kinds)
        if ((DISCLOSURE_KINDS as readonly unknown[]).includes(kind))
          this.disclosed.add(kind as DisclosureKind);
    } else if (type === 'route.decision') this.route = routeOf(payload);
  }

  /** A segment's sink that feeds this memory first. */
  sink(inner: EventSink): EventSink {
    return {
      append: async (type, payload) => {
        this.observe(type, payload);
        await inner.append(type, payload);
      },
    };
  }

  /** Final caller words, and agent lines as the caller heard them. */
  transcript(event: Transcript): void {
    if (event.type === 'user.transcript') {
      if (event.stability === 'final') this.add('caller', event.text);
      return;
    }
    if (event.state === 'played') this.add('agent', event.text);
    else if (event.state === 'interrupted' && event.spokenPrefix)
      this.add('agent', event.spokenPrefix);
  }

  /** The kept lines, oldest first. */
  recent(): readonly TranscriptLine[] {
    return this.lines;
  }

  started(entry: SegmentHistoryEntry): void {
    this.segments.push(entry);
  }

  /** The agent releases the call has already left, for the ping-pong guard. */
  leftReleases(currentIndex: number): Set<string> {
    return new Set(
      this.segments
        .filter((entry) => entry.role === 'agent' && entry.index !== currentIndex)
        .map((entry) => entry.releaseId),
    );
  }

  private add(role: TranscriptLine['role'], raw: string): void {
    const text = raw.trim().slice(0, MAX_LINE_CHARS);
    if (!text) return;
    this.lines.push({ role, text });
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }
}

function routeOf(payload: Record<string, unknown>): RouteMemory {
  const context = payload.context;
  return {
    path: Array.isArray(payload.path) ? payload.path.filter((key) => typeof key === 'string') : [],
    ...(typeof payload.language === 'string' ? { language: payload.language } : {}),
    context:
      context && typeof context === 'object' && !Array.isArray(context)
        ? Object.fromEntries(
            Object.entries(context).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {},
  };
}
