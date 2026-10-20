'use client';
import { useState } from 'react';
import { PoolConsiderationCard } from '../../../components/routing/pool-consideration';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { Conversation, type ConversationLine } from '../../../components/ui/conversation';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { SectionCard } from '../../../components/ui/section-card';
import { formatDuration } from '../../../lib/format';
import { takenFallbacks } from '../../../lib/derive/routing-path';
import { OUTCOME_LABEL, type SimForm } from '../../../lib/derive/routing-simulate';
import type { RoutingSimulationResult, SimulatedAnswer, SimulatedEngine } from '../../../lib/types/routing-simulate';
import { AnswerAsDrawer } from './answer-as-drawer';
import { RoutePath } from './route-path';
import { SaveAsCase } from './save-case';
import { TraceTable } from './trace-table';

function conversation(result: RoutingSimulationResult): ConversationLine[] {
  return result.turns.flatMap((turn) => {
    const lines: ConversationLine[] = [];
    if (turn.input.kind === 'speech') lines.push({ id: `c${turn.index}`, speaker: 'caller', text: turn.input.text, atMs: turn.virtualMs });
    if (turn.input.kind === 'dtmf') lines.push({ id: `c${turn.index}`, speaker: 'caller', text: `Pressed ${turn.input.digits}`, atMs: turn.virtualMs });
    if (turn.input.kind === 'silence') lines.push({ id: `c${turn.index}`, speaker: 'caller', text: '(quiet)', atMs: turn.virtualMs });
    if (turn.say) lines.push({ id: `a${turn.index}`, speaker: 'agent', text: turn.say, atMs: turn.virtualMs });
    return lines;
  });
}

/** KPIs, the path, the trace, the conversation, the pools considered, warnings, and saving a case. */
export function SimResults({
  result,
  form,
  branchesOf,
  timeZone,
  onAnswer,
}: {
  result: RoutingSimulationResult;
  form: SimForm;
  branchesOf: (node: string) => string[];
  timeZone?: string;
  onAnswer: (answer: SimulatedAnswer) => void;
}) {
  const [answering, setAnswering] = useState<{ node: string; engine: SimulatedEngine }>();
  const { outcome } = result;
  return (
    <div className="rt-stack" aria-live="polite">
      <KpiStrip>
        <KpiCard label="Outcome" value={OUTCOME_LABEL[outcome.status]} footnote={outcome.completionReason ?? undefined} />
        <KpiCard label="Questions asked" value={outcome.path.length} />
        <KpiCard label="Router turns" value={result.stats.routerTurns} />
        <KpiCard label="Fallbacks taken" value={takenFallbacks(result)} />
        <KpiCard label="Route time" value={formatDuration(outcome.routeMs)} footnote="Simulated clock" />
      </KpiStrip>
      {result.warnings.map((w, i) => (
        <InlineAlert key={i} tone="warn">{w.message}</InlineAlert>
      ))}
      <SectionCard title="Route taken" description={`Simulated at ${new Date(result.at).toISOString().replace('T', ' ').slice(0, 16)} UTC, ${result.source.kind === 'draft' ? 'from the draft' : `from release v${result.source.version ?? '?'}`}.`}>
        <RoutePath result={result} />
      </SectionCard>
      <SectionCard title="Engine attempts" padding="flush">
        <TraceTable result={result} onAnswerAs={(node, engine) => setAnswering({ node, engine })} />
      </SectionCard>
      <SectionCard title="Conversation">
        <Conversation lines={conversation(result)} />
      </SectionCard>
      {result.pools.length > 0 && (
        <SectionCard title="Pools considered" description="Who was eligible and who was picked.">
          <div className="rt-stack">{result.pools.map((p, i) => <PoolConsiderationCard key={i} pool={p} />)}</div>
        </SectionCard>
      )}
      <SaveAsCase form={form} result={result} timeZone={timeZone} />
      <AnswerAsDrawer
        target={answering}
        branches={answering ? branchesOf(answering.node) : []}
        onClose={() => setAnswering(undefined)}
        onSubmit={(answer) => {
          setAnswering(undefined);
          onAnswer(answer);
        }}
      />
    </div>
  );
}
