// A timeline from per-turn summaries alone (`/v1/calls/:id/turns`), for calls whose events were
// not exported (call 4, e8a43f65). Coarse: each summary's `startedAt` is when the turn was decided
// (its VAD stop, or its final), so a turn's speech is modelled as ending `endpointMs` before it, its
// first audio comes `firstAudioMs` after it, and its lines are one line of its `agentText`.
import type { TurnSummary } from '../corpus/load.ts';
import type { AgentLine, CallTimeline, CallerTurn } from '../timeline.ts';

export function summaryTimeline(summaries: readonly TurnSummary[]): CallTimeline {
  const zero = Date.parse(summaries[0]?.startedAt ?? '');
  const turns: CallerTurn[] = [];
  const agent: AgentLine[] = [];
  for (const [index, summary] of summaries.entries()) {
    const at = Date.parse(summary.startedAt) - zero;
    if (summary.input === 'speech') {
      const endpointMs = summary.endpointMs ?? undefined;
      turns.push({
        turnId: summary.turnId,
        // Modelled: about 2.7 words a second before its end.
        startedAtMs: at - (summary.userText?.split(/\s+/).length ?? 1) * 370,
        endedAtMs: at,
        outcome: 'stopped',
        input: 'speech',
        text: summary.userText ?? '',
        ...(endpointMs === undefined ? {} : { endpointMs }),
        ...(summary.endpointRule ? { rule: summary.endpointRule } : {}),
      });
    }
    if (summary.agentText)
      agent.push({
        segmentId: `summary-${index}`,
        epoch: index,
        kind: 'response',
        text: summary.agentText,
        generatedAtMs: at + (summary.firstSegmentMs ?? 0),
        turnId: summary.turnId,
        ...(summary.firstAudioMs === null ? {} : { audibleAtMs: at + summary.firstAudioMs }),
        outcome: summary.interrupted ? 'interrupted' : 'completed',
      });
  }
  const llm = summaries.flatMap((summary, index) =>
    Array.from({ length: summary.llmCalls }, (_, n) => ({
      atMs: Date.parse(summary.startedAt) - zero,
      id: `summary-${index}-${n}`,
    })),
  );
  return {
    turns,
    agent,
    transcripts: [],
    llm,
    interrupts: [],
    durationMs: Date.parse(summaries.at(-1)?.startedAt ?? '') - zero,
  };
}
