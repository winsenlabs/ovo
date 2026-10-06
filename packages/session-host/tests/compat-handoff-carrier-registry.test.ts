import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { plivoCapabilities } from '../../plugin-carrier-plivo/src/plugin.ts';
import { validateSelections } from '../src/compat/index.ts';
import { carrier, catalog, data, fixture, withConfig } from './compat-support.ts';

const transfers = { ...carrier, control: { ...carrier.control, handoff: ['phone', 'queue'] } };
const handoff = {
  transfer: { target: { kind: 'phone', e164: '+918041234567' }, onRecoveryExhausted: true },
};
const blockers = (input: Parameters<typeof validateSelections>[0], stage: 'release' | 'live') =>
  validateSelections(input, stage).filter(
    (issue) => issue.field === 'handoff.transfer.target.kind',
  );

describe('transfer support in release and live validation (AGT-15)', () => {
  it('blocks the release when its carrier cannot transfer', () => {
    const input = withConfig(fixture(), { mode: 'agent', handoff });
    expect(blockers(input, 'release')).toEqual([
      expect.objectContaining({ code: 'termination_unsupported', severity: 'error' }),
    ]);
  });

  it('blocks a live call that arrived on a carrier that cannot transfer', () => {
    const input = withConfig(fixture({ carrier: { capabilities: transfers } }), {
      mode: 'agent',
      handoff,
    });
    const plivo = catalog({ carrier: { id: 'plivo', capabilities: plivoCapabilities } })[
      Object.keys(data).indexOf('carrier')
    ]!;
    input.registry = new PluginRegistry([
      ...catalog({ carrier: { capabilities: transfers } }),
      plivo,
    ]);
    expect(blockers(input, 'release')).toEqual([]);
    input.actualCarrier = { ...input.selections!.carrier!, pluginId: 'plivo' };
    expect(blockers(input, 'live')).toEqual([
      expect.objectContaining({ code: 'termination_unsupported', pluginId: 'plivo' }),
    ]);
  });
});
