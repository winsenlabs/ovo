import type { QueueSnapshot } from '../human-queue/queue.ts';
import type { HoldPolicy, RoutingTransferPolicy, TransferTarget } from './transfer.ts';

/** Built-in transfer lines, the default hold, and which hold and label a handoff uses (R2). */

/** Built-in lines (en, hi; Hindi phrased gender-neutral). Other default languages must author them. */
export const TRANSFER_BUILT_IN_LINES = Object.freeze({
  announcement: {
    en: "I'm transferring your call now. Please stay on the line.",
    hi: 'आपकी कॉल ट्रांसफर की जा रही है। कृपया लाइन पर बने रहें।',
  },
  queue: {
    en: 'All our colleagues are busy right now. Please hold and you will be connected shortly.',
    hi: 'अभी सभी सहयोगी व्यस्त हैं। कृपया होल्ड करें, आपको जल्द ही जोड़ा जाएगा।',
  },
  hold: {
    en: 'Thank you for holding. Someone will be with you shortly.',
    hi: 'होल्ड करने के लिए धन्यवाद। कोई जल्द ही आपसे बात करेगा।',
  },
  end: {
    en: 'Sorry, we could not connect your call right now. Please call again later. Goodbye.',
    hi: 'क्षमा करें, अभी आपकी कॉल नहीं जोड़ी जा सकी। कृपया बाद में फिर कॉल करें। धन्यवाद।',
  },
  returned: {
    en: "Sorry, I couldn't connect you. I'm still here with you. How can I help?",
    hi: 'क्षमा करें, कॉल ट्रांसफर नहीं हो पाई। मैं अभी भी आपके साथ हूँ। बताइए, कैसे मदद करूँ?',
  },
  confirm: { en: 'Shall I transfer you to {label}?', hi: 'क्या मैं आपको {label} से जोड़ दूँ?' },
  /** R3: said before a human queue's hold. */
  human: {
    en: "I'm connecting you to a colleague. Please hold.",
    hi: 'आपको एक सहयोगी से जोड़ा जा रहा है। कृपया होल्ड करें।',
  },
  /** R3: the default callback promise when a queue cannot connect the caller. */
  callback: {
    en: 'We could not connect you right now. We will call you back. Goodbye.',
    hi: 'अभी आपकी कॉल नहीं जोड़ी जा सकी। हम आपको वापस कॉल करेंगे। धन्यवाद।',
  },
} as const);

/** The hold used when neither the target nor the point configures one (R1-equivalent failure path). */
export const DEFAULT_HOLD_POLICY: HoldPolicy = Object.freeze<HoldPolicy>({
  steps: [
    { kind: 'silence', seconds: 3 },
    { kind: 'line', line: { ...TRANSFER_BUILT_IN_LINES.hold } },
  ],
  loopFrom: 0,
  maxSeconds: 60,
  waitForCapacity: false,
  onTimeout: [{ kind: 'default' }, { kind: 'end', line: { ...TRANSFER_BUILT_IN_LINES.end } }],
});

/** The hold of a handoff: the target's, else the point's, else the default. */
export function effectiveHold(policy: RoutingTransferPolicy | undefined, key?: string): HoldPolicy {
  const target = key === undefined ? undefined : policy?.targets.find((t) => t.key === key);
  return target?.hold ?? policy?.hold ?? DEFAULT_HOLD_POLICY;
}

/** The spoken name of a target in a language: its label, else its key with separators as spaces. */
export function transferLabel(target: Pick<TransferTarget, 'key' | 'label'>, language: string) {
  return target.label?.[language] ?? target.key.replace(/[_-]+/g, ' ');
}

/** R3: the hold of a human queue when neither the queue, the target nor the point configures one. */
export const DEFAULT_QUEUE_HOLD_POLICY: HoldPolicy = Object.freeze<HoldPolicy>({
  steps: [
    { kind: 'silence', seconds: 2 },
    { kind: 'line', line: { ...TRANSFER_BUILT_IN_LINES.hold } },
  ],
  loopFrom: 0,
  maxSeconds: 180,
  waitForCapacity: false,
  onTimeout: [
    { kind: 'return' },
    { kind: 'default' },
    { kind: 'end', line: { ...TRANSFER_BUILT_IN_LINES.end } },
  ],
});

type QueueHolds = {
  queues?: Record<string, Pick<QueueSnapshot, 'key' | 'definition'>>;
  transfer?: RoutingTransferPolicy;
};
export type QueueHoldSource = 'queue' | 'target' | 'point' | 'default';

/** The pinned queue bound under `key`, if the snapshot holds it. */
export function queueByKey(
  snapshot: Pick<QueueHolds, 'queues'>,
  key: string,
): Pick<QueueSnapshot, 'key' | 'definition'> | undefined {
  return Object.values(snapshot.queues ?? {}).find((found) => found.key === key);
}

/** Which configuration `effectiveQueueHold` used. */
export function queueHoldSource(
  snapshot: QueueHolds,
  queueKey: string,
  transferKey?: string,
): QueueHoldSource {
  if (queueByKey(snapshot, queueKey)?.definition.hold) return 'queue';
  const target = snapshot.transfer?.targets.find((t) => t.key === transferKey);
  if (target?.hold) return 'target';
  return snapshot.transfer?.hold ? 'point' : 'default';
}

/**
 * The hold of a human handoff: the queue's own, else the catalogue target's, else the point's,
 * else `DEFAULT_QUEUE_HOLD_POLICY`. `queueKey` is the binding key in the release.
 */
export function effectiveQueueHold(
  snapshot: QueueHolds,
  queueKey: string,
  transferKey?: string,
): HoldPolicy {
  return (
    queueByKey(snapshot, queueKey)?.definition.hold ??
    (transferKey === undefined
      ? undefined
      : snapshot.transfer?.targets.find((t) => t.key === transferKey)?.hold) ??
    snapshot.transfer?.hold ??
    DEFAULT_QUEUE_HOLD_POLICY
  );
}
