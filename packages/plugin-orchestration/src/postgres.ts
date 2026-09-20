import { Pool, type PoolConfig } from 'pg';
import type {
  CapacityLeaseStore,
  ClaimedJob,
  DurableJob,
  DurableJobStore,
  OutboxRecord,
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

/** Thin facade preserving one pooled transaction boundary while repositories stay responsibility-focused. */
export class PostgresOrchestrationStore implements DurableJobStore, CapacityLeaseStore {
  readonly pool: Pool;
  readonly jobs: JobRepository;
  readonly outbox: OutboxRepository;
  readonly capacity: CapacityRepository;
  readonly leases: CapacityLeaseRepository;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
    this.jobs = new JobRepository(this.pool);
    this.outbox = new OutboxRepository(this.pool);
    this.capacity = new CapacityRepository(this.pool);
    this.leases = new CapacityLeaseRepository(this.pool);
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
  claim(jobId: string, workerId: string, leaseMs: number): Promise<ClaimedJob | undefined> {
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
  beginDial(jobId: string, workerId: string, epoch: number, requestId: string): Promise<boolean> {
    return this.jobs.beginDial(jobId, workerId, epoch, requestId);
  }
  markDialAccepted(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
  ): Promise<boolean> {
    return this.jobs.markDialAccepted(jobId, workerId, epoch, requestId, carrierCallId);
  }
  markDialUnknown(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    reason: string,
  ): Promise<boolean> {
    return this.jobs.markDialUnknown(jobId, workerId, epoch, requestId, reason);
  }
  markFailed(jobId: string, workerId: string, epoch: number, reason: string): Promise<boolean> {
    return this.jobs.markFailed(jobId, workerId, epoch, reason);
  }
  get(jobId: string): Promise<DurableJob | undefined> {
    return this.jobs.get(jobId);
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
  reportWorker(input: WorkerReport): Promise<boolean> {
    return this.capacity.reportWorker(input);
  }
  readCapacitySnapshot(): Promise<CapacitySnapshot> {
    return this.capacity.readSnapshot();
  }
}
