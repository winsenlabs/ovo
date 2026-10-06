import { useState, type ComponentType } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfig as AgentConfigSchema, TurnConfigSchema } from '@winsendotai/ovo-contracts';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { ComplianceEditor, DEFAULT_DISCLOSURE, type AgentCompliance } from './compliance-editor';
import { DEFAULT_TURN_DETECTOR, TurnPacingEditor } from './turn-pacing-editor';
import { CallPolicyPanels } from './call-policy-panels';

afterEach(() => cleanup());

type Editor = ComponentType<{ config: AgentConfig; update: (next: AgentConfig) => void }>;

function harness(Editor: Editor, initial: AgentConfig) {
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState<AgentConfig>(initial);
    return (
      <Editor
        config={config}
        update={(next) => {
          current = next;
          setConfig(next);
        }}
      />
    );
  }
  render(<Harness />);
  return () => current;
}
const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  ...emptyAgentConfig(),
  mode: 'agent',
  ...over,
});
const compliance = (config: AgentConfig) =>
  (config as AgentConfig & { compliance?: AgentCompliance }).compliance;

describe('outbound compliance editor', () => {
  it('sets calling hours, a disclosure and the opt-out, then clears them', () => {
    const read = harness(ComplianceEditor, agent());
    fireEvent.click(screen.getByLabelText(/Restrict calling hours/));
    expect(compliance(read())).toEqual({ callingHours: { start: '08:00', end: '19:00' } });
    fireEvent.click(screen.getByLabelText('Sun'));
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Dubai' } });
    expect(compliance(read())?.callingHours).toEqual({
      start: '08:00',
      end: '19:00',
      days: [1, 2, 3, 4, 5, 6],
      timezone: 'Asia/Dubai',
    });
    fireEvent.change(screen.getByLabelText('Until (exclusive)'), { target: { value: '07:00' } });
    expect(screen.getByText('End must be after start.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Until (exclusive)'), { target: { value: '19:00' } });
    fireEvent.click(screen.getByLabelText(/Recording disclosure/));
    expect(compliance(read())?.disclosure).toEqual({ text: DEFAULT_DISCLOSURE });
    fireEvent.click(screen.getByLabelText(/stop calling me/));
    fireEvent.change(screen.getByLabelText('Closing line'), { target: { value: 'Okay, bye.' } });
    expect(compliance(read())?.optOut).toEqual({
      enabled: true,
      phrases: [],
      closingLine: 'Okay, bye.',
    });
    // Everything else in the config is untouched, and still a valid AgentConfig.
    expect(() => AgentConfigSchema.parse(read())).not.toThrow();
    fireEvent.click(screen.getByLabelText(/Restrict calling hours/));
    fireEvent.click(screen.getByLabelText(/Recording disclosure/));
    fireEvent.click(screen.getByLabelText(/stop calling me/));
    expect(compliance(read())).toBeUndefined();
  });

  it('allows calling hours but not the spoken blocks outside agent mode', () => {
    harness(ComplianceEditor, agent({ mode: 'faq' }));
    expect(screen.getByLabelText(/Restrict calling hours/)).not.toHaveProperty('disabled', true);
    expect(screen.getByLabelText(/Recording disclosure/)).toHaveProperty('disabled', true);
    expect(screen.getByLabelText(/stop calling me/)).toHaveProperty('disabled', true);
  });
});

describe('turn pacing editor (Wave 4 knobs)', () => {
  const voiced = () =>
    agent({
      voice: { textFilters: [], acknowledgements: [] },
      decision: {
        enabled: true,
        questions: [],
        state: { sources: ['last-turn'], transcriptTurns: 6 },
        timeoutMs: 800,
      },
    });

  it('writes backchannels and filler into the turn detector row the contract accepts', () => {
    const read = harness(TurnPacingEditor, voiced());
    fireEvent.click(screen.getByLabelText(/Ignore acknowledgements/));
    fireEvent.click(screen.getByLabelText(/Filler line on slow replies/));
    fireEvent.change(screen.getByLabelText('Play after (ms)'), { target: { value: '800' } });
    const detector = read().voice?.turnDetector;
    expect(detector?.plugin).toBe(DEFAULT_TURN_DETECTOR);
    expect(detector?.config).toEqual({
      backchannelsEnabled: false,
      filler: { lines: ['Hmm, one moment.'], afterMs: 800 },
    });
    expect(() => TurnConfigSchema.parse(detector?.config)).not.toThrow();
    expect(() => AgentConfigSchema.parse(read())).not.toThrow();
  });

  it('shows the speculative LLM on by default and turns speculation off', () => {
    const read = harness(TurnPacingEditor, voiced());
    const llm = screen.getByLabelText(/Ask the LLM alongside the decision/) as HTMLInputElement;
    expect(llm.checked).toBe(true);
    expect(screen.getByText(/billed even when aborted/)).toBeTruthy();
    fireEvent.click(llm);
    expect(read().decision?.speculation).toEqual({ llm: false });
    expect(screen.queryByText(/billed even when aborted/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Decide on partial transcripts/));
    expect(read().decision?.speculation).toEqual({ llm: false, partials: false });
    expect(() => AgentConfigSchema.parse(read())).not.toThrow();
  });

  it('sets and clears the per-agent minFirstWords', () => {
    const read = harness(TurnPacingEditor, voiced());
    const input = screen.getByLabelText('Words before the first clause break');
    fireEvent.change(input, { target: { value: '5' } });
    expect(read().reply).toEqual({ minFirstWords: 5 });
    expect(() => AgentConfigSchema.parse(read())).not.toThrow();
    fireEvent.change(input, { target: { value: '' } });
    expect(read().reply).toBeUndefined();
  });

  it('explains where the detector knobs live when the agent has no plugin selection', () => {
    const read = harness(TurnPacingEditor, agent());
    expect(screen.getByText(/Select plugins for this agent/)).toBeTruthy();
    expect(screen.queryByLabelText(/Filler line/)).toBeNull();
    expect(
      screen.getByText(/Speculation applies once the agent has a decision policy/),
    ).toBeTruthy();
    expect(read().voice).toBeUndefined();
  });
});

describe('call policy panels', () => {
  it('shows turn pacing only in agent mode, and compliance and the speech cache always', () => {
    render(<CallPolicyPanels config={agent({ mode: 'faq' })} update={() => undefined} />);
    expect(screen.queryByText('Turn pacing')).toBeNull();
    expect(screen.getByText('Outbound compliance')).toBeTruthy();
    expect(screen.getByText('Approved speech cache policy')).toBeTruthy();
    cleanup();
    render(<CallPolicyPanels config={agent()} update={() => undefined} />);
    expect(screen.getByText('Turn pacing')).toBeTruthy();
  });
});
