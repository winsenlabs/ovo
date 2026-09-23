import { type PoolConfig, Pool } from 'pg';
import type {
  CapacityLeaseStore,
  CapacityWriteAttempt,
  CapacityWriteGuard,
  CapacityWritePermit,
  CarrierRouteStore,
  DurableJob,
  DurableJobStore,
  JobClaimResult,
  OutboxRecord,
} from './types.ts';
import { runMigrations } from './postgres/migrations.ts';
import { OutboxRepository } from './postgres/outbox.ts';
import {
  CapacityRepository,
  type WorkerReport,
  type CapacitySnapshot,
} from './postgres/capacity-repository.ts';
import { CapacityLeaseRepository } from './postgres/leases.ts';
import { PostgresCapacityWriteGuard } from './postgres/capacity-writes.ts';
import { PostgresSessionStoreBase } from './postgres-session-store.ts';

/** Thin facade preserving one pooled transaction boundary while repositories stay responsibility-focused. */
export class PostgresOrchestrationStore
  extends PostgresSessionStoreBase
  implements DurableJobStore, CarrierRouteStore, CapacityLeaseStore, CapacityWriteGuard
{
  readonly outbox: OutboxRepository;
  readonly capacity: CapacityRepository;
  readonly leases: CapacityLeaseRepository;
  readonly capacityWrites: PostgresCapacityWriteGuard;

  constructor(config: PoolConfig | Pool) {
    super(config);
    this.outbox = new OutboxRepository(this.pool);
    this.capacity = new CapacityRepository(this.pool);
    this.leases = new CapacityLeaseRepository(this.pool);
    this.capacityWrites = new PostgresCapacityWriteGuard(this.pool);
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
