import type {
  AdmissionSnapshot,
  BindCarrierCallInput,
  BindCarrierCallResult,
  IssueStreamGrantInput,
  MarkDialAcceptedInput,
  ReissueStreamInput,
  RouteLookup,
  SessionRoute,
} from './session-types.ts';

/** Carrier-neutral host seam; legacy worker stores only implement DurableJobStore. */
export interface CarrierRouteStore {
  markDialAccepted(input: MarkDialAcceptedInput): Promise<boolean>;
  resolveSessionRoute(input: RouteLookup): Promise<SessionRoute | undefined>;
  bindCarrierCallId(input: BindCarrierCallInput): Promise<BindCarrierCallResult>;
  issueStreamGrant(input: IssueStreamGrantInput): Promise<SessionRoute | undefined>;
  reissueStream(input: ReissueStreamInput): Promise<SessionRoute | undefined>;
  admissionSnapshot(): Promise<AdmissionSnapshot>;
}
