import { describe, expect, it } from 'vitest';
import { plivoCapabilities } from '../../plugin-carrier-plivo/src/plugin.ts';
import { handoffCarrierUnsupported } from '../src/compat/handoff-carrier-unsupported.ts';
import { carrier, fixture, withConfig } from './compat-support.ts';

const phone = { kind: 'phone', e164: '+918041234567' };

/** The compat fixture on a carrier with the given control capabilities, and a transfer config. */
function transferOn(capabilities: object, transfer: Record<string, unknown>) {
  return withConfig(fixture({ carrier: { capabilities } }), {
    mode: 'agent',
    handoff: { transfer: { target: phone, ...transfer } },
  });
}

describe('a transfer the carrier cannot carry out (AGT-15)', () => {
  it('blocks a release whose carrier cannot transfer, as on Plivo, for every trigger', () => {
    for (const trigger of [
      { llmTool: true },
      { onDecisionUnavailable: true },
      { onRecoveryExhausted: true },
    ])
      for (const stage of ['release', 'live'] as const)
        expect(handoffCarrierUnsupported(transferOn(plivoCapabilities, trigger), stage)).toEqual([
          expect.objectContaining({
            code: 'termination_unsupported',
            severity: 'error',
            stage,
            slot: 'carrier',
            pluginId: 'carrier',
            field: 'handoff.transfer.target.kind',
          }),
        ]);
  });

  it('blocks a target kind the carrier does not list', () => {
    const phoneOnly = { ...carrier, control: { ...carrier.control, handoff: ['phone'] } };
    const input = transferOn(phoneOnly, {
      target: { kind: 'queue', name: 'support' },
      llmTool: true,
    });
    expect(handoffCarrierUnsupported(input, 'release')).toHaveLength(1);
  });

  it('is quiet on a carrier that transfers, with no trigger, and without a transfer', () => {
    const twilioLike = { ...carrier, control: { ...carrier.control, handoff: ['phone', 'queue'] } };
    expect(handoffCarrierUnsupported(transferOn(twilioLike, { llmTool: true }), 'live')).toEqual(
      [],
    );
    expect(handoffCarrierUnsupported(transferOn(plivoCapabilities, {}), 'release')).toEqual([]);
    expect(
      handoffCarrierUnsupported(
        fixture({ carrier: { capabilities: plivoCapabilities } }),
        'release',
      ),
    ).toEqual([]);
  });
});
