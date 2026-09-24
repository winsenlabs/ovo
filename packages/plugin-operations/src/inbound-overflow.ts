import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { recordBusy } from './inbound-existing.ts';
import type { InboundCarrierRoute } from './inbound-carrier.ts';
import type { InboundGatewayCall, InboundGatewayDecision, InboundOverflowPolicy } from './types.ts';

type PolicyRow = QueryResultRow & { policy: InboundOverflowPolicy };

export async function inboundOverflow(
  client: PoolClient,
  organizationId: string,
  input: InboundGatewayCall,
  route: InboundCarrierRoute,
  callbackOutbound: { enabled: boolean; permittedFromNumbers: readonly string[] },
): Promise<InboundGatewayDecision> {
  const policy = await client.query<PolicyRow>(
    'SELECT policy FROM ovo_ops_inbound_policy WHERE organization_id = $1',
    [organizationId],
  );
  const configured = policy.rows[0]?.policy;
  if (configured?.kind === 'wait') {
    const admissionId = randomUUID();
    const expiresAt = new Date(Date.now() + configured.maxWaitMs);
    await client.query(
      `INSERT INTO ovo_ops_inbound_admissions
          (id, organization_id, call_id, decision, detail, from_number, to_number,
            route_version, release_id, variables, wait_expires_at,
            carrier_plugin_id, carrier_binding_id)
         VALUES ($1,$2,$3,'wait',$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [
        admissionId,
        organizationId,
        input.carrierCallId,
        JSON.stringify(configured),
        input.fromNumber,
        input.toNumber,
        route.version,
        route.release_id,
        JSON.stringify(route.variables),
        expiresAt,
        route.carrier_plugin_id,
        route.carrier_binding_id,
      ],
    );
    return {
      kind: 'wait',
      admissionId,
      announcement: configured.announcement,
      expiresAt,
      pollAfterMs: Math.max(1_000, Math.min(5_000, configured.maxWaitMs)),
    };
  }
  if (configured?.kind === 'callback') {
    if (
      !callbackOutbound.enabled ||
      !callbackOutbound.permittedFromNumbers.includes(input.toNumber)
    )
      return recordBusy(
        client,
        organizationId,
        input,
        'callback_outbound_not_configured',
        configured,
      );
    const admissionId = randomUUID();
    const detail = { ...configured, state: 'prompt' };
    await client.query(
      `INSERT INTO ovo_ops_inbound_admissions
           (id, organization_id, call_id, decision, detail, from_number, to_number,
            route_version, release_id, variables)
         VALUES ($1,$2,$3,'callback',$4::jsonb,$5,$6,$7,$8,$9::jsonb)`,
      [
        admissionId,
        organizationId,
        input.carrierCallId,
        JSON.stringify(detail),
        input.fromNumber,
        input.toNumber,
        route.version,
        route.release_id,
        JSON.stringify(route.variables),
      ],
    );
    return {
      kind: 'callback',
      admissionId,
      state: 'prompt',
      announcement: configured.announcement,
    };
  }
  if (configured?.kind === 'human') {
    const admissionId = randomUUID();
    await client.query(
      `INSERT INTO ovo_ops_inbound_admissions
           (id, organization_id, call_id, decision, detail, from_number, to_number)
         VALUES ($1, $2, $3, 'human', $4::jsonb, $5, $6)`,
      [
        admissionId,
        organizationId,
        input.carrierCallId,
        JSON.stringify(configured),
        input.fromNumber,
        input.toNumber,
      ],
    );
    return {
      kind: 'human',
      admissionId,
      target: configured.target,
      announcement: configured.announcement,
    };
  }
  const reason = configured?.kind === 'busy' ? configured.reason : 'inbound_policy_not_configured';
  return recordBusy(client, organizationId, input, reason, configured);
}
