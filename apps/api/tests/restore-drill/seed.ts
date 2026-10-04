import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AgentConfig, type OperationRecord } from '@winsendotai/ovo-contracts';
import { PostgresControlStore } from '../../../../packages/plugin-storage/src/index.ts';
import { PostgresOrchestrationStore } from '../../../../packages/plugin-orchestration/src/index.ts';
import {
  LiveRecordingService,
  LocalRecordingBackend,
} from '../../../../packages/plugin-recordings/src/index.ts';
import { PostgresRecordingRepository } from '../../../../packages/plugin-recordings/src/production.ts';
import { PostgresCostLedger } from '../../../../packages/plugin-ledger/src/index.ts';
import { PostgresOperationsService } from '../../../../packages/plugin-operations/src/index.ts';
import { PostgresTelemetryStore } from '../../../../packages/plugin-observability/src/index.ts';
import { UserDirectory } from '../../src/user-directory.ts';
import { seedRestoreDrillEvaluations } from './evaluations.ts';

interface OwnerIdentity {
  ownerId: string;
  ownerEpoch: number;
}

export interface RestoreDrillFixture {
  objects: LocalRecordingBackend;
  recordingId: string;
  releaseId: string;
  operationId: string;
  duplicateJobId: string;
  queuedAtBackupJobId: string;
  staleJobOwner: OwnerIdentity;
  dialingJobId: string;
  staleDialOwner: OwnerIdentity;
  dialRequestId: string;
  evaluationRunId: string;
  providerEvaluationRunId: string;
  providerAuthorizationId: string;
  staleEvaluationEpoch: number;
  operationContactId: string;
  queuedOperationContactId: string;
  operationCampaignId: string;
  staleOperationEpoch: number;
  inboundWaitCallId: string;
  inboundCallbackCallId: string;
  inboundFromNumber: string;
  inboundToNumber: string;
  teamUserId: string;
  teamUserSessionVersion: number;
}

export async function seedRestoreDrillFixture(input: {
  sourceUrl: string;
  workspaceId: string;
  scratch: string;
}): Promise<RestoreDrillFixture> {
  const { sourceUrl, workspaceId, scratch } = input;
  const control = await PostgresControlStore.open(sourceUrl);
  await control.ensureWorkspace(workspaceId, 'Restore drill organization');
  const userPool = new Pool({ connectionString: sourceUrl });
  const users = new UserDirectory(userPool, workspaceId);
  await users.initialize();
  const teamUser = await users.create({
    email: 'restore-admin@example.test',
    label: 'Restore administrator',
    role: 'admin',
    password: 'Restore-user-password-v1!',
  });
  if (!teamUser) throw new Error('failed to seed restore drill team user');
  const teamUserState = await userPool.query<{ session_version: number }>(
    'SELECT session_version FROM ovo_team_users WHERE organization_id=$1 AND id=$2',
    [workspaceId, teamUser.id],
  );
  await userPool.end();
  const agent = await control.createAgent(
    workspaceId,
    AgentConfig.parse({ name: 'Restore drill', mode: 'announcement', message: 'Restored' }),
  );
  const releaseId = (
    await control.createRelease({
      workspaceId,
      agent,
      plugins: [{ id: 'ovo.behavior.announcement', version: '1.0.0' }],
      createdBy: 'drill',
    })
  ).id;
  const operation: OperationRecord = {
    id: randomUUID(),
    workspaceId,
    sessionId: 'drill-session',
    toolId: 'drill-tool',
    input: { fixture: true },
    state: 'intent',
    createdAt: new Date().toISOString(),
  };
  await control.operationStore.createIntent(operation);

  const orchestration = new PostgresOrchestrationStore({ connectionString: sourceUrl });
  await orchestration.migrate();
  const duplicateJobId = randomUUID();
  await orchestration.enqueue({
    id: duplicateJobId,
    workspaceId,
    idempotencyKey: 'duplicate-delivery',
    payload: { fixture: true },
  });
  const duplicateClaim = await orchestration.claim(duplicateJobId, 'worker-before-restore', 60_000);
  if (duplicateClaim.kind !== 'execute') throw new Error('failed to own duplicate drill job');
  const queuedAtBackupJobId = randomUUID();
  await orchestration.enqueue({
    id: queuedAtBackupJobId,
    workspaceId,
    idempotencyKey: 'queued-outbound-at-backup',
    payload: { fixture: true, kind: 'outbound_call' },
  });
  const dialingJobId = randomUUID();
  await orchestration.enqueue({
    id: dialingJobId,
    workspaceId,
    idempotencyKey: 'dial-before-restore',
    payload: { fixture: true },
  });
  const dialClaim = await orchestration.claim(dialingJobId, 'dial-worker-before-restore', 60_000);
  if (dialClaim.kind !== 'execute') throw new Error('failed to own dial drill job');
  const dialRequestId = `dial-${dialingJobId}`;
  await orchestration.beginDialSession({
    sessionId: randomUUID(),
    jobId: dialingJobId,
    organizationId: workspaceId,
    workerId: dialClaim.job.ownerId,
    workerEndpoint: 'ws://worker.invalid/internal/media',
    ownerEpoch: dialClaim.job.ownerEpoch,
    generation: 1,
    dialRequestId,
    handshakeTokenHash: 'restore-drill-token',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  });

  const objects = new LocalRecordingBackend(`${scratch}/objects`);
  const recordingRepository = new PostgresRecordingRepository({ connectionString: sourceUrl });
  await recordingRepository.migrate();
  const recordings = new LiveRecordingService(recordingRepository, objects);
  const recording = await recordings.create({
    workspaceId,
    callId: 'call-recording',
    retentionDays: 1,
    segmentBytes: 64 * 1024,
  });
  await recordings.writeSegment({
    recording,
    track: 'inbound',
    sequence: 0,
    bytes: Uint8Array.of(1, 2, 3),
    startMs: 0,
    endMs: 0.375,
  });
  await recordings.delete(workspaceId, 'call-recording', recording.id, 'operator');

  const costPool = new Pool({ connectionString: sourceUrl });
  const ledger = new PostgresCostLedger(costPool);
  await ledger.migrate();
  await ledger.putPriceCard({
    id: 'drill-card',
    version: 'v1',
    provider: 'fixture',
    unit: 'characters',
    currency: 'INR',
    minorUnitsPerBlock: '1',
    blockQuantity: '1',
    effectiveAt: new Date().toISOString(),
    provenance: 'local restore drill',
  });

  const {
    evaluationRunId,
    providerEvaluationRunId,
    providerAuthorizationId,
    staleEvaluationEpoch,
  } = await seedRestoreDrillEvaluations({ sourceUrl, workspaceId, releaseId });

  const operations = new PostgresOperationsService({
    connectionString: sourceUrl,
    organizationId: workspaceId,
  });
  await operations.migrate();
  const inboundWaitCallId = 'CA-restore-wait';
  const inboundCallbackCallId = 'CA-restore-callback';
  const inboundFromNumber = '+14155550110';
  const inboundToNumber = '+14155550111';
  await operations.pool.query(
    `INSERT INTO ovo_ops_inbound_admissions
       (id,organization_id,call_id,decision,detail,from_number,to_number,route_version,
        release_id,variables,wait_expires_at)
     VALUES
       ($1,$3,$4,'wait',$6::jsonb,$8,$9,1,$10,'{}'::jsonb,now()+interval '1 hour'),
       ($2,$3,$5,'callback',$7::jsonb,$8,$9,1,$10,'{}'::jsonb,NULL)`,
    [
      randomUUID(),
      randomUUID(),
      workspaceId,
      inboundWaitCallId,
      inboundCallbackCallId,
      JSON.stringify({ kind: 'wait', announcement: 'Please wait', maxWaitMs: 60_000 }),
      JSON.stringify({
        kind: 'callback',
        state: 'prompt',
        queue: 'restore-callbacks',
        announcement: 'Request a callback',
      }),
      inboundFromNumber,
      inboundToNumber,
      releaseId,
    ],
  );
  const campaign = await operations.campaigns.create(
    {
      operationId: 'restore-campaign',
      name: 'Restore campaign',
      agentReleaseId: releaseId,
      fromNumber: '+14155550000',
      schedule: { localDateTime: '2026-01-15T12:00', timezone: 'UTC' },
      perNumberAttemptLimit: 2,
      maxAttemptsTotal: 2,
      maxAttemptsPerLocalDay: 2,
      activeCallPolicy: 'continue',
    },
    [
      { sourceRow: 2, phoneNumber: '+14155550100', variables: {} },
      { sourceRow: 3, phoneNumber: '+14155550101', variables: {} },
    ],
  );
  const admitted = await operations.campaigns.admit(
    campaign.id,
    'operations-before-restore',
    60_000,
  );
  if (admitted.kind !== 'admitted') throw new Error(`failed to admit operation: ${admitted.kind}`);
  const operationContacts = await operations.pool.query<{ id: string }>(
    `SELECT id FROM ovo_ops_campaign_contacts
     WHERE campaign_id=$1 AND id<>$2 AND state='queued'`,
    [campaign.id, admitted.contactId],
  );

  const telemetry = await PostgresTelemetryStore.open(sourceUrl);
  await telemetry.close();
  await operations.close();
  await costPool.end();
  await recordingRepository.close();
  await orchestration.close();
  await control.close();

  return {
    objects,
    recordingId: recording.id,
    releaseId,
    operationId: operation.id,
    duplicateJobId,
    queuedAtBackupJobId,
    staleJobOwner: duplicateClaim.job,
    dialingJobId,
    staleDialOwner: dialClaim.job,
    dialRequestId,
    evaluationRunId,
    providerEvaluationRunId,
    providerAuthorizationId,
    staleEvaluationEpoch,
    operationContactId: admitted.contactId,
    queuedOperationContactId: operationContacts.rows[0]!.id,
    operationCampaignId: campaign.id,
    staleOperationEpoch: admitted.ownerEpoch,
    inboundWaitCallId,
    inboundCallbackCallId,
    inboundFromNumber,
    inboundToNumber,
    teamUserId: teamUser.id,
    teamUserSessionVersion: teamUserState.rows[0]!.session_version,
  };
}
