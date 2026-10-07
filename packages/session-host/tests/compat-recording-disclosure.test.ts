import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { recordingDisclosure } from '../src/compat/recording-disclosure.ts';

const agent = (fields: Record<string, unknown>) =>
  ({ config: AgentConfig.parse({ name: 'A', mode: 'agent', ...fields }) }) as never;
const disclosure = { disclosure: { text: 'This call is recorded for quality purposes.' } };

describe('recording and its disclosure', () => {
  it('warns about the live agent: it said "this call is recorded" with recording off', () => {
    const issues = recordingDisclosure(agent({ compliance: disclosure }), 'release');
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'recording_disclosure_mismatch',
        severity: 'warning',
        field: 'recording',
      }),
    ]);
  });

  it('warns about a recording agent that tells nobody', () => {
    expect(recordingDisclosure(agent({ recording: true }), 'release')).toEqual([
      expect.objectContaining({ field: 'compliance.disclosure', severity: 'warning' }),
    ]);
  });

  it('is quiet when they agree, in English or Hindi', () => {
    expect(
      recordingDisclosure(agent({ recording: true, compliance: disclosure }), 'release'),
    ).toEqual([]);
    const hindi = { disclosure: { text: 'यह कॉल रिकॉर्ड की जा रही है।' } };
    expect(recordingDisclosure(agent({ recording: true, compliance: hindi }), 'release')).toEqual(
      [],
    );
    expect(recordingDisclosure(agent({}), 'release')).toEqual([]);
  });
});
