// One load-test call: a fake Twilio caller through the real gateway, a worker and the fake providers.
import { FakeTwilioCall } from '../../tests/e2e/support/fake-twilio-caller.ts';

export interface CallResult {
  index: number;
  callSid: string;
  /** Answered, heard the reply, and settled `completed` after the hang-up. */
  ok: boolean;
  error?: string;
  /** Caller speech start (media connect) to the first agent audio frame, as the caller hears it. */
  firstAgentAudioMs: number | null;
  /** The status callback's HTTP status: 204 when OVO accepted the hang-up. */
  hangupStatus?: number;
}

export interface CallPlan {
  gateway: { origin: string; publicBaseUrl: string };
  account: { accountSid: string; authToken: string };
  to: string;
  urls: { voice: string; status: string };
  /** How long the call stays up after the reply starts, so calls overlap. */
  holdMs: number;
  /** Generous ceiling for the reply under load. */
  replyTimeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(10);
  }
  return check();
}

export async function runCall(index: number, plan: CallPlan): Promise<CallResult> {
  const from = `+9198${String(10_000_000 + index).padStart(8, '0')}`;
  const call = new FakeTwilioCall(plan.gateway, plan.account, { from, to: plan.to });
  const result: CallResult = { index, callSid: call.callSid, ok: false, firstAgentAudioMs: null };
  try {
    const answer = await call.ring(plan.urls.voice);
    if (answer.status !== 200 || !answer.twiml.includes('<Stream'))
      throw new Error(`answer ${answer.status}: ${answer.twiml.slice(0, 160)}`);
    await call.connect(answer.twiml);
    const connectedAt = Date.now();
    if (!(await until(() => call.agentAudioBytes > 0, plan.replyTimeoutMs)))
      throw new Error(`no agent audio within ${plan.replyTimeoutMs} ms`);
    result.firstAgentAudioMs = Date.now() - connectedAt;
    call.fallSilent();
    await sleep(plan.holdMs);
    if (!call.connected) throw new Error('the call was dropped before the caller hung up');
    result.hangupStatus = await call.hangUp(plan.urls.status);
    result.ok = result.hangupStatus === 204;
    if (!result.ok) result.error = `hang-up callback returned ${result.hangupStatus}`;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    call.close();
  }
  return result;
}
