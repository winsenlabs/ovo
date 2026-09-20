import { Pool, type PoolConfig } from 'pg';
import type {
  CapacityLeaseStore,
  CapacityWriteAttempt,
  CapacityWriteGuard,
  CapacityWritePermit,
  CarrierCallbackInput,
  CarrierCallbackResult,
  AuthenticatedSessionRoute,
  BeginDialSessionInput,
  DurableJob,
  DurableJobStore,
  JobClaimResult,
  OutboxRecord,
  SessionRoute,
} from './types.ts';
import { runMigrations } from './postgres/migrations.ts';
import { JobRepository } from './postgres/jobs.ts';
import { OutboxRepository } from './postgres/outbox.ts';
import {
  CapacityRepository,
  type WorkerReport,
  type CapacitySnapshot,
} from './postgres/capacity-repository.ts';
import { CapacityLeaseRepository } from './postgres/leases.ts';
import { PostgresCapacityWriteGuard } from './postgres/capacity-writes.ts';
import { SessionRepository } from './postgres/sessions.ts';
import { CarrierCallbackRepository } from './postgres/callbacks.ts';

/** Thin facade preserving one pooled transaction boundary while repositories stay responsibility-focused. */
export class PostgresOrchestrationStore
  implements DurableJobStore, CapacityLeaseStore, CapacityWriteGuard
{
  readonly pool: Pool;
  readonly jobs: JobRepository;
  readonly outbox: OutboxRepository;
  readonly capacity: CapacityRepository;
  readonly leases: CapacityLeaseRepository;
  readonly capacityWrites: PostgresCapacityWriteGuard;
  readonly sessions: SessionRepository;
  readonly callbacks: CarrierCallbackRepository;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
    this.jobs = new JobRepository(this.pool);
    this.outbox = new OutboxRepository(this.pool);
    this.capacity = new CapacityRepository(this.pool);
    this.leases = new CapacityLeaseRepository(this.pool);
    this.capacityWrites = new PostgresCapacityWriteGuard(this.pool);
    this.sessions = new SessionRepository(this.pool);
    this.callbacks = new CarrierCallbackRepository(this.pool);
  }

  migrate(): Promise<void> {
    return runMigrations(this.pool);
  }
  close(): Promise<void> {
    return this.pool.end();
  }
  ping(): Promise<void> {
    return this.pool.query('SELECT 1').then(() => undefined);
  }

  enqueue(input: {
    id: string;
    workspaceId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    notBefore?: Date;
  }): Promise<{ job: DurableJob; created: boolean }> {
    return this.jobs.enqueue(input);
  }
  claim(jobId: string, workerId: string, leaseMs: number): Promise<JobClaimResult> {
    return this.jobs.claim(jobId, workerId, leaseMs);
  }
  heartbeat(jobId: string, workerId: string, epoch: number, leaseMs: number): Promise<boolean> {
    return this.jobs.heartbeat(jobId, workerId, epoch, leaseMs);
  }
  release(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
    notBefore?: Date,
  ): Promise<boolean> {
    return this.jobs.release(jobId, workerId, epoch, reason, notBefore);
  }
  updateOwnedPayload(
    jobId: string,
    workerId: string,
    epoch: number,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    return this.jobs.updateOwnedPayload(jobId, workerId, epoch, payload);
  }
  beginDialSession(input: BeginDialSessionInput): Promise<SessionRoute | undefined> {
    return this.sessions.beginDial(input);
  }
  markDialAccepted(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
  ): Promise<boolean> {
    return this.sessions.markDialAccepted({
      jobId,
      workerId,
      ownerEpoch: epoch,
      dialRequestId: requestId,
      carrierCallId,
    });
  }
  markDialUnknown(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    reason: string,
  ): Promise<boolean> {
    return this.sessions.markDialUnknown({
      jobId,
      workerId,
      ownerEpoch: epoch,
      dialRequestId: requestId,
      reason,
    });
  }
  prepareReconciledTermination(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
    reason: string,
  ): Promise<boolean> {
    return this.sessions.prepareReconciledTermination({
      jobId,
      workerId,
      ownerEpoch: epoch,
      dialRequestId: requestId,
      carrierCallId,
      reason,
    });
  }
  deferReconciliation(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
    notBefore: Date,
  ): Promise<boolean> {
    return this.jobs.deferReconciliation(jobId, workerId, epoch, reason, notBefore);
  }
  markFailed(jobId: string, workerId: string, epoch: number, reason: string): Promise<boolean> {
    return this.sessions.markFailed({ jobId, workerId, ownerEpoch: epoch, reason });
  }
  get(jobId: string): Promise<DurableJob | undefined> {
    return this.jobs.get(jobId);
  }
  getSessionRoute(jobId: string): Promise<SessionRoute | undefined> {
    return this.sessions.getByJob(jobId);
  }
  resolveSessionRoute(input: {
    sessionId?: string;
    carrierCallId?: string;
  }): Promise<SessionRoute | undefined> {
    return this.sessions.resolve(input);
  }
  authenticateSessionRoute(
    sessionId: string,
    token: string,
  ): Promise<AuthenticatedSessionRoute | undefined> {
    return this.sessions.authenticate(sessionId, token);
  }
  applyCarrierCallback(input: CarrierCallbackInput): Promise<CarrierCallbackResult> {
    return this.callbacks.apply(input);
  }
  requestSessionTermination(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
  ): Promise<{ carrierCallId?: string } | undefined> {
    return this.sessions.requestTermination({
      jobId,
      workerId,
      ownerEpoch: epoch,
      reason,
    });
  }
  findCarrierCallId(requestId: string): Promise<string | undefined> {
    return this.pool
      .query<{ carrier_call_id: string | null }>(
        'SELECT carrier_call_id FROM ovo_session_routes WHERE dial_request_id = $1',
        [requestId],
      )
      .then((result) => result.rows[0]?.carrier_call_id ?? undefined);
  }
  releaseTerminalSession(jobId: string): Promise<boolean> {
    return this.sessions.releaseTerminal(jobId);
  }
  releaseTerminalSessions(limit = 100): Promise<number> {
    return this.sessions.releaseTerminalBatch(limit);
  }

  listTerminalSessions(limit = 100): Promise<SessionRoute[]> {
    return this.sessions.listUnreleasedTerminal(limit);
  }

  claimOutbox(publisherId: string, limit?: number, claimMs?: number): Promise<OutboxRecord[]> {
    return this.outbox.claim(publisherId, limit, claimMs);
  }
  markOutboxSent(id: string, publisherId: string): Promise<boolean> {
    return this.outbox.markSent(id, publisherId);
  }
  markOutboxFailed(id: string, publisherId: string, error: string): Promise<void> {
    return this.outbox.markFailed(id, publisherId, error);
  }

  acquire(
    serviceKey: string,
    authorityId: string,
    leaseMs: number,
  ): Promise<{ epoch: number } | undefined> {
    return this.leases.acquire(serviceKey, authorityId, leaseMs);
  }
  renew(serviceKey: string, authorityId: string, epoch: number, leaseMs: number): Promise<boolean> {
    return this.leases.renew(serviceKey, authorityId, epoch, leaseMs);
  }
  begin(input: {
    serviceKey: string;
    authorityId: string;
    epoch: number;
    desiredCount: number;
  }): Promise<CapacityWritePermit> {
    return this.capacityWrites.begin(input);
  }
  markApplied(attemptId: string): Promise<boolean> {
    return this.capacityWrites.markApplied(attemptId);
  }
  markUnknown(attemptId: string, error: string): Promise<boolean> {
    return this.capacityWrites.markUnknown(attemptId, error);
  }
  pending(serviceKey: string): Promise<CapacityWriteAttempt | undefined> {
    return this.capacityWrites.pending(serviceKey);
  }
  reportWorker(input: WorkerReport): Promise<boolean> {
    return this.capacity.reportWorker(input);
  }
  readCapacitySnapshot(): Promise<CapacitySnapshot> {
    return this.capacity.readSnapshot();
  }
}
