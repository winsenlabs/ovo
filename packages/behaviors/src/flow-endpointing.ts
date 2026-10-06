import {
  flowEndpointing,
  type FlowEndpointing,
  type SttConfigurationUpdate,
} from '@winsendotai/ovo-contracts';
import type { FlowSession } from './flow-session.ts';

/**
 * Follows a call through its flow and reports the STT endpointing of each state it moves to
 * (Wave 4 request 5), once per change: `fast` after a yes/no question, `patient` while the caller
 * reads out a date. The behaviour emits each update as an `stt.configure` event, which the engine
 * applies to a provider that can retune mid-call. A state whose node, listen set and flow set no
 * preset sends nothing, so the binding's own endpointing stays until the flow first sets one.
 */
export function followFlowEndpointing(
  flow: Pick<FlowSession, 'compiled' | 'onTransition'>,
  configure: (update: SttConfigurationUpdate) => void,
): () => void {
  let sent: FlowEndpointing | undefined;
  return flow.onTransition((transition) => {
    const preset = flowEndpointing(flow.compiled.flow, transition.to);
    if (preset === undefined || preset === sent) return;
    sent = preset;
    configure({ endpointing: preset });
  });
}
