import type { Logger } from '@winsendotai/ovo-contracts';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import type {
  DurableJobStore,
  PostgresOrchestrationStore,
  TaskProtection,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';

/** Dependencies of the inbound capacity runtime: protection, registration, floor and admission. */
export interface InboundWorkerRuntimeInput {
  workerId: string;
  workerEndpoint: string;
  generation: number;
  protection: TaskProtection;
  operations: OperationsService;
  store: DurableJobStore;
  floor: Pick<PostgresOrchestrationStore, 'claimInboundFloorToken' | 'releaseInboundFloorToken'>;
  organizationId: string;
  inboundWarmFloor: number;
  telephony: TelephonyControl;
  costs: ProductionWorkerCostRuntime;
  terminateOwned?: (jobId: string, ownerEpoch: number, reason: string) => Promise<boolean>;
  onProtectionLost: (reason: string) => void;
  onSessionActive?: (jobId: string) => void;
  onSessionIdle?: (jobId: string) => void;
  /** Defaults to a JSON-lines logger at OVO_LOG_LEVEL. */
  logger?: Logger;
}
