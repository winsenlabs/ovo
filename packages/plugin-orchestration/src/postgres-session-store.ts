import { Pool, type PoolConfig } from 'pg';
import type {
  AuthenticatedSessionRoute,
  BeginDialSessionInput,
  CarrierCallbackInput,
  CarrierCallbackCorrelationInput,
  CarrierCallbackResult,
  DurableJob,
  MarkDialAcceptedInput,
  RouteLookup,
  BindCarrierCallInput,
  BindCarrierCallResult,
  IssueStreamGrantInput,
  ReissueStreamInput,
  AdmissionSnapshot,
  CarrierCallIdMismatchInput,
  SessionRoute,
} from './types.ts';
import { JobRepository } from './postgres/jobs.ts';
import { SessionRepository } from './postgres/sessions.ts';
import { SessionDialRepository } from './postgres/session-dial.ts';
import { SessionGrantRepository } from './postgres/session-grants.ts';
import { SessionReleaseRepository } from './postgres/session-release.ts';
import { CarrierCallbackRepository } from './postgres/callbacks.ts';
import { recordCarrierCallIdMismatch } from './postgres/carrier-audit.ts';

export class PostgresSessionStoreBase {
  readonly pool: Pool;
  readonly jobs: JobRepository;
  readonly sessions: SessionRepository;
  readonly sessionDial: SessionDialRepository;
  readonly grants: SessionGrantRepository;
  readonly sessionRelease: SessionReleaseRepository;
  readonly callbacks: CarrierCallbackRepository;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
    this.jobs = new JobRepository(this.pool);
    this.sessions = new SessionRepository(this.pool);
    this.sessionDial = new SessionDialRepository(this.pool);
    this.grants = new SessionGrantRepository(this.pool);
    this.sessionRelease = new SessionReleaseRepository(this.pool);
    this.callbacks = new CarrierCallbackRepository(this.pool);
  }

  beginDialSession(input: BeginDialSessionInput): Promise<SessionRoute | undefined> {
    return this.sessions.beginDial(input);
  }
  markDialAccepted(input: MarkDialAcceptedInput): Promise<boolean>;
  markDialAccepted(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    carrierCallId: string,
  ): Promise<boolean>;
  markDialAccepted(
    inputOrJobId: MarkDialAcceptedInput | string,
    workerId?: string,
    epoch?: number,
    requestId?: string,
    carrierCallId?: string,
  ): Promise<boolean> {
    const input =
      typeof inputOrJobId === 'string'
        ? {
            jobId: inputOrJobId,
            workerId: workerId!,
            ownerEpoch: epoch!,
            dialRequestId: requestId!,
            carrierCallId,
          }
        : inputOrJobId;
    return this.sessionDial.markDialAccepted(input);
  }
  markDialUnknown(
    jobId: string,
    workerId: string,
    epoch: number,
    requestId: string,
    reason: string,
  ): Promise<boolean> {
    return this.sessionDial.markDialUnknown({
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
    return this.sessionDial.prepareReconciledTermination({
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
    return this.sessionRelease.markFailed({ jobId, workerId, ownerEpoch: epoch, reason });
  }
  get(jobId: string): Promise<DurableJob | undefined> {
    return this.jobs.get(jobId);
  }
  getSessionRoute(jobId: string): Promise<SessionRoute | undefined> {
    return this.sessions.getByJob(jobId);
  }
  resolveSessionRoute(input: RouteLookup): Promise<SessionRoute | undefined> {
    return this.sessions.resolve(input);
  }
  bindCarrierCallId(input: BindCarrierCallInput): Promise<BindCarrierCallResult> {
    return this.grants.bindCarrierCallId(input);
  }
  issueStreamGrant(input: IssueStreamGrantInput): Promise<SessionRoute | undefined> {
    return this.grants.issueStreamGrant(input);
  }
  reissueStream(input: ReissueStreamInput): Promise<SessionRoute | undefined> {
    return this.grants.reissueStream(input);
  }
  recordCarrierCallIdMismatch(input: CarrierCallIdMismatchInput): Promise<void> {
    return recordCarrierCallIdMismatch(this.pool, input);
  }
  admissionSnapshot(): Promise<AdmissionSnapshot> {
    return this.grants.admissionSnapshot();
  }
  authenticateSessionRoute(
    sessionId: string,
    token: string,
  ): Promise<AuthenticatedSessionRoute | undefined> {
    return this.sessions.authenticate(sessionId, token);
  }
  applyCarrierCallback(input: CarrierCallbackCorrelationInput): Promise<CarrierCallbackResult>;
  applyCarrierCallback(input: CarrierCallbackInput): Promise<CarrierCallbackResult>;
  applyCarrierCallback(input: CarrierCallbackCorrelationInput): Promise<CarrierCallbackResult> {
    return this.callbacks.apply(input);
  }
  requestSessionTermination(
    jobId: string,
    workerId: string,
    epoch: number,
    reason: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
  requestSessionTermination(
    route: Pick<SessionRoute, 'sessionId' | 'jobId' | 'workerId' | 'ownerEpoch'>,
    reason: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined>;
  requestSessionTermination(
    routeOrJobId: Pick<SessionRoute, 'sessionId' | 'jobId' | 'workerId' | 'ownerEpoch'> | string,
    workerIdOrReason: string,
    epoch?: number,
    reason?: string,
  ): Promise<{ carrierCallId?: string; carrierRequestId?: string } | undefined> {
    return this.sessions.requestTermination({
      jobId: typeof routeOrJobId === 'string' ? routeOrJobId : routeOrJobId.jobId,
      workerId: typeof routeOrJobId === 'string' ? workerIdOrReason : routeOrJobId.workerId,
      ownerEpoch: typeof routeOrJobId === 'string' ? epoch! : routeOrJobId.ownerEpoch,
      reason: typeof routeOrJobId === 'string' ? reason! : workerIdOrReason,
      ...(typeof routeOrJobId === 'string' ? {} : { sessionId: routeOrJobId.sessionId }),
    });
  }
  findCarrierCallId(requestId: string): Promise<string | undefined> {
    return this.pool
      .query<{ carrier_call_id: string | null }>(
        'SELECT carrier_call_id FROM ovo_session_routes WHERE dial_request_id = $1 LIMIT 2',
        [requestId],
      )
      .then((result) =>
        result.rows.length === 1 ? (result.rows[0]?.carrier_call_id ?? undefined) : undefined,
      );
  }
  releaseTerminalSession(jobId: string): Promise<boolean> {
    return this.sessionRelease.releaseTerminal(jobId);
  }
  releaseTerminalSessions(limit = 100): Promise<number> {
    return this.sessionRelease.releaseTerminalBatch(limit);
  }

  listTerminalSessions(limit = 100): Promise<SessionRoute[]> {
    return this.sessionRelease.listUnreleasedTerminal(limit);
  }
}
