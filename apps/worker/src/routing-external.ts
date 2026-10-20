// The external decision client moved to the session host so the API's route tester can use it too.
export {
  callExternalRouteEngine,
  EXTERNAL_DECISION_MAX_BYTES,
  routeDecisionSignature,
  type ExternalRouteOptions,
} from '@winsendotai/ovo-session-host';
