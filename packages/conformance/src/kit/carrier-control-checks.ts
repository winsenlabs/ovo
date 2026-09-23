import type { HandoffTarget } from '@winsendotai/ovo-contracts';
import { carrier, touchedNetwork } from './carrier-harness.ts';
import type { CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

const TARGETS: readonly HandoffTarget[] = [
  { kind: 'phone', e164: '+15550123' },
  { kind: 'queue', name: 'kit-queue' },
  { kind: 'resume' },
  { kind: 'end', message: 'Goodbye.' },
];

/** TelephonyControl surface beyond dial and hangup: reconcile and handoff (#F7). */
export const CARRIER_CONTROL_CHECKS: readonly KitCheck<CarrierKitContext>[] = [
  {
    name: 'reconcile follows the declared strategy',
    async run(context) {
      const f = new Failures();
      const probe = await carrier(context);
      const mode = probe.ingress.capabilities.control.reconcile;
      if (mode === 'none') {
        const result = await probe.telephony.reconcile({
          requestId: 'dial-1',
          carrierCallId: 'CA-kit',
          carrierRequestId: 'RQ-kit',
        });
        f.expect(
          result.kind === 'pending',
          `reconcile: 'none' carriers must report pending, got ${result.kind}`,
        );
        f.expect(!touchedNetwork(probe.net), "reconcile: 'none' carrier reached the network");
        return f.messages;
      }
      const spec = context.options.rest?.reconcile;
      if (!spec) return [`carriers that reconcile '${mode}' must supply rest.reconcile scripts`];
      f.expect(
        mode === 'by-call-id' ? spec.query.carrierCallId : spec.query.carrierRequestId,
        `rest.reconcile.query must carry the ${mode} identifier`,
      );
      const run = await carrier(context, spec.scripts);
      const result = await run.telephony.reconcile(spec.query);
      f.expect(result.kind === spec.expect, `reconcile returned ${JSON.stringify(result)}`);
      if (spec.state && (result.kind === 'live' || result.kind === 'ended'))
        f.expect(result.state === spec.state, `reconcile state is ${result.state}`);
      f.add(
        ...run.net.mismatches.map((e) => e.message),
        ...run.net.pending().map((p) => `reconcile: unconsumed ${p.description}`),
      );
      // Without any carrier identifier there is nothing to look up: pending, and no REST call.
      const bare = await carrier(context);
      const none = await bare.telephony.reconcile({ requestId: spec.query.requestId });
      f.expect(
        none.kind === 'pending',
        `reconcile without a carrier id returned ${none.kind}, not pending`,
      );
      f.expect(
        !touchedNetwork(bare.net),
        'reconcile without a carrier id still reached the network',
      );
      return f.messages;
    },
  },
  {
    name: 'handoff performs every declared target kind and refuses the rest',
    async run(context) {
      const f = new Failures();
      const probe = await carrier(context);
      const kinds = probe.ingress.capabilities.control.handoff;
      const specs = context.options.rest?.handoff ?? [];
      for (const kind of kinds) {
        const spec = specs.find((entry) => entry.target.kind === kind);
        if (
          !f.expect(
            spec,
            `control.handoff declares '${kind}' but rest.handoff has no scripts for it`,
          )
        )
          continue;
        const run = await carrier(context, spec!.scripts);
        const result = await run.telephony.handoff(
          spec!.carrierCallId,
          spec!.target,
          spec!.requestId ?? 'handoff-1',
        );
        f.expect(
          result.kind === (spec!.expect ?? 'confirmed'),
          `handoff '${kind}' returned ${JSON.stringify(result)}`,
        );
        if (result.kind === 'confirmed')
          f.expect(result.receiptId, `handoff '${kind}' confirmed without a receiptId`);
        f.add(
          ...run.net.mismatches.map((e) => e.message),
          ...run.net.pending().map((p) => `handoff '${kind}': unconsumed ${p.description}`),
        );
      }
      const undeclared = TARGETS.find((target) => !kinds.includes(target.kind));
      if (undeclared) {
        const run = await carrier(context);
        const result = await run.telephony.handoff('CA-kit', undeclared, 'handoff-undeclared');
        f.expect(
          result.kind === 'rejected',
          `handoff to the undeclared '${undeclared.kind}' returned ${result.kind}`,
        );
        f.expect(
          !touchedNetwork(run.net),
          `handoff to the undeclared '${undeclared.kind}' reached the network`,
        );
      }
      return f.messages;
    },
  },
];
