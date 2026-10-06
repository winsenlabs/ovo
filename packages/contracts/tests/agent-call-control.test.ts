import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentDecisionPolicy,
  DECISION_STATE_SOURCES,
  effectiveVoicemailPolicy,
  SESSION_INPUT_JSON_SCHEMA,
} from '../src/index.ts';

const agent = (over: Record<string, unknown>) =>
  AgentConfig.safeParse({ name: 'Collections', mode: 'agent', ...over });

describe('agent opening, voicemail and ending', () => {
  it('accepts an opening, a voicemail message and the end_call tool on an agent', () => {
    const parsed = agent({
      opening: { lines: ['Hello, this is Asha.'] },
      voicemail: { action: 'message', message: 'Please call us back.' },
      ending: { llmTool: true },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.voicemail).toEqual({
      detect: true,
      timeoutMs: 4000,
      action: 'message',
      message: 'Please call us back.',
    });
  });

  it.each(['opening', 'voicemail', 'ending'])('rejects %s outside agent mode', (field) => {
    const value = {
      opening: { lines: ['Hello.'] },
      voicemail: {},
      ending: { llmTool: true },
    }[field];
    const parsed = AgentConfig.safeParse({ name: 'A', mode: 'faq', [field]: value });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual([field]);
  });

  it('requires the message for a voicemail message action', () => {
    expect(agent({ voicemail: { action: 'message' } }).success).toBe(false);
  });

  it('reserves end_call when the LLM may end the call', () => {
    const tool = {
      id: 'end_call',
      description: 'An authored tool',
      connector: 'native',
      inputSchema: { type: 'object' },
      effect: 'read',
    };
    expect(agent({ tools: [tool], ending: { llmTool: true } }).success).toBe(false);
    expect(agent({ tools: [tool] }).success).toBe(true);
  });

  it('detects a machine by default only for an agent that speaks first', () => {
    const opening = { lines: ['Hello.'] };
    expect(effectiveVoicemailPolicy({ opening })).toEqual({
      detect: true,
      timeoutMs: 4000,
      action: 'hangup',
    });
    expect(effectiveVoicemailPolicy({})).toBeUndefined();
    const off = agent({ opening, voicemail: { detect: false } }).data!;
    expect(effectiveVoicemailPolicy(off)).toBeUndefined();
  });

  it('lets a decision outcome end the call, and state show the last line and today', () => {
    const parsed = AgentDecisionPolicy.safeParse({
      enabled: true,
      questions: [
        {
          type: 'noul',
          id: 'done',
          instructions: 'Is the caller done?',
          threshold: 0.8,
          fallback: 'llm',
          yes: { description: 'Done', outcome: { say: 'Goodbye.', end: true } },
          no: { description: 'Not done', outcome: {} },
        },
      ],
      state: { sources: ['agent-last-said', 'today', 'last-turn'] },
    });
    expect(parsed.success).toBe(true);
    expect(DECISION_STATE_SOURCES).toContain('agent-last-said');
  });

  it('carries the answering-machine hold in the strict engine session schema', () => {
    const properties = SESSION_INPUT_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(properties.amd).toMatchObject({ required: ['timeoutMs'] });
  });
});
