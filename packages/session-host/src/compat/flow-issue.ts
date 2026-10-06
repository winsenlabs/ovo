import type {
  CompatCode,
  CompatIssue,
  CompatStage,
  FlowCompatCode,
} from '@winsendotai/ovo-contracts';
import { issue } from './types.ts';

/**
 * `issue` for the flow's own codes. `FLOW_COMPAT_CODES` join `COMPAT_CODES` through
 * `contracts/src/blockers.ts`; the widening keeps this file correct whether or not that list has
 * already been extended, and is a no-op once it has.
 */
export function flowIssue(
  code: FlowCompatCode | CompatCode,
  stage: CompatStage,
  message: string,
  extra: Partial<CompatIssue> = {},
  severity: CompatIssue['severity'] = 'error',
): CompatIssue {
  return issue(code as CompatCode, stage, message, extra, severity);
}
