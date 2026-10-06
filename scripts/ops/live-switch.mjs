// OPS-8 `ovo-live on|off`: points the carrier number at this stack (the console's signed inbound and
// status URLs) or at the fallback TwiML. Switching the number takes effect on the next call with no
// container restart, which is what the preemption shutdown path needs inside its ~30 s notice.
// Import-free: scripts/deploy/lib.sh concatenates it after ops-client.mjs.

export function classifyNumber(current, { targets, fallbackUrl }) {
  if (targets?.inbound && current.voiceUrl === targets.inbound) return 'stack';
  if (fallbackUrl && current.voiceUrl === fallbackUrl) return 'fallback';
  return 'other';
}

/** The Twilio fields to change; empty when the number is already where it should be. */
export function planLiveSwitch(direction, current, { targets, fallbackUrl }) {
  const wanted =
    direction === 'on'
      ? {
          voiceUrl: targets?.inbound,
          voiceMethod: 'POST',
          statusCallback: targets?.status,
          statusCallbackMethod: 'POST',
          ...(fallbackUrl ? { voiceFallbackUrl: fallbackUrl, voiceFallbackMethod: 'POST' } : {}),
        }
      : // The status callback stays on the stack so calls still in flight reconcile their outcome.
        { voiceUrl: fallbackUrl, voiceMethod: 'POST' };
  for (const [field, value] of Object.entries(wanted))
    if (!value) throw new Error(`cannot switch ${direction}: no value for ${field}`);
  return Object.fromEntries(
    Object.entries(wanted).filter(([field, value]) => current[field] !== value),
  );
}

export async function switchNumber({
  direction,
  twilio,
  number,
  targets,
  fallbackUrl,
  dryRun,
  log,
}) {
  const before = await twilio.find(number);
  const fields = planLiveSwitch(direction, before, { targets, fallbackUrl });
  const changed = Object.keys(fields);
  if (!changed.length) {
    log(`${number} already points ${direction === 'on' ? 'at this stack' : 'at the fallback'}`);
    return { before, after: before, changed };
  }
  if (dryRun) {
    log(`dry run: would set ${changed.join(', ')} on ${number} (${before.sid})`);
    return { before, after: before, changed };
  }
  await twilio.update(before.sid, fields);
  // Read back rather than trust the update reply, so a silently ignored field is caught.
  const after = await twilio.find(number);
  const stuck = changed.filter((field) => after[field] !== fields[field]);
  if (stuck.length) throw new Error(`${number} did not keep ${stuck.join(', ')} after the update`);
  log(
    `${number} now points ${direction === 'on' ? 'at this stack' : 'at the fallback'} (changed ${changed.join(', ')})`,
  );
  return { before, after, changed };
}
