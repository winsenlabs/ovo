import type { PlaybackEvidence, SpeechReceipt } from '@winsendotai/ovo-contracts';
import { sleep } from './runner.ts';
import { FAQ, LONG_ANSWER, type EngineScenario } from './engine-scenario-setup.ts';

const ANSWER = /nine to five/;
const heard = (h: Parameters<EngineScenario['run']>[0]) =>
  h.receipts().find((r) => ANSWER.test(r.receipt.text))?.receipt;

/**
 * One §2.5 evidence row. Only 'carrier-played' → 'confirmed' was ever observed, because no
 * scenario set `carrier.playbackEvidence` and `acknowledgements` was hard-coded to [] (#F16).
 * §18.2 makes mis-mapping this a blocking readiness error, so a broken engine must fail here.
 */
function evidenceRow(
  name: string,
  carrier: { playbackEvidence?: PlaybackEvidence; playback?: 'realtime' | 'manual' },
  expected: Pick<SpeechReceipt, 'evidence'> & { evidenceSource?: string },
  acknowledgements: readonly ('weak-playback-evidence' | never)[] = [],
): EngineScenario {
  return {
    name,
    setup: {
      agent: FAQ,
      carrier,
      ...(acknowledgements.length ? { session: { acknowledgements: [...acknowledgements] } } : {}),
    },
    async run(h, f) {
      await h.say('what are your opening hours');
      await h.until(() => Boolean(heard(h)), 'the FAQ receipt', h.timeoutMs + 5000);
      const receipt = heard(h)!;
      f.expect(receipt.state === 'completed', `the receipt state is ${receipt.state}`);
      f.expect(
        receipt.evidence === expected.evidence,
        `the receipt evidence is '${receipt.evidence}', expected '${expected.evidence}'`,
      );
      f.expect(
        receipt.evidenceSource === expected.evidenceSource,
        `the receipt evidenceSource is ${JSON.stringify(receipt.evidenceSource)}, expected ${JSON.stringify(expected.evidenceSource)}`,
      );
      const terminal = h.phases(ANSWER).find((p) => p.phase === 'completed');
      f.expect(
        terminal?.evidence === receipt.evidence,
        `the 'completed' phase reports '${terminal?.evidence}' but the receipt reports '${receipt.evidence}'`,
      );
      const caps = h.underTest.capabilities;
      if (caps && !caps.confirmedPlayback)
        f.expect(
          receipt.evidence !== 'confirmed',
          'capabilities.confirmedPlayback is false but the engine confirmed a segment',
        );
    },
  };
}

/** §2.5 receipt evidence mapping, and the clear-ordering consequence for barged-in audio. */
export const EVIDENCE_SCENARIOS: readonly EngineScenario[] = [
  evidenceRow(
    "a 'carrier-played' carrier confirms the receipt",
    { playbackEvidence: 'carrier-played' },
    { evidence: 'confirmed' },
  ),
  evidenceRow(
    "a 'carrier-processed' carrier only estimates the receipt",
    { playbackEvidence: 'carrier-processed' },
    { evidence: 'estimated' },
  ),
  evidenceRow(
    "a carrier with 'none' playback evidence only estimates the receipt",
    { playbackEvidence: 'none' },
    { evidence: 'estimated' },
  ),
  evidenceRow(
    'a mark that never comes back estimates the receipt on any carrier',
    { playbackEvidence: 'carrier-played', playback: 'manual' },
    { evidence: 'estimated' },
  ),
  evidenceRow(
    "the 'weak-playback-evidence' acknowledgement confirms carrier-processed playback",
    { playbackEvidence: 'carrier-processed' },
    { evidence: 'confirmed', evidenceSource: 'carrier-processed' },
    ['weak-playback-evidence'],
  ),
  {
    /** Nothing may reach the carrier after media.clear: 2 s of stale audio used to pass (#F15). */
    name: 'no audio reaches the carrier after an interrupt',
    setup: { agent: FAQ, tts: { msPerChar: 20 } },
    async run(h, f) {
      const spoken = h.underTest.speech.speak(LONG_ANSWER, { kind: 'response' });
      await h.until(
        () => h.carrier.log.some((e) => e.type === 'audio'),
        'the first audio chunk to reach the carrier',
      );
      await sleep(100);
      await h.underTest.speech.interrupt();
      await h.until(() => h.carrier.log.some((e) => e.type === 'clear'), 'media.clear');
      const clearedAt = h.carrier.log.findIndex((e) => e.type === 'clear');
      await sleep(500);
      const late = h.carrier.log.slice(clearedAt + 1).filter((e) => e.type === 'audio');
      f.expect(
        late.length === 0,
        `${late.length} audio writes reached the carrier after media.clear`,
      );
      const receipt = await spoken;
      f.expect(
        receipt.state === 'interrupted',
        `the interrupted segment finished as ${receipt.state}`,
      );
      f.expect(
        receipt.evidence !== 'confirmed',
        'a cleared segment produced a confirmed receipt for audio the caller never heard',
      );
    },
  },
];
