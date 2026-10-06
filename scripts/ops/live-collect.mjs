// OPS-7: `collectLiveSnapshot` reads the running stack from inside the API container; the checks
// in live-checks.mjs evaluate the snapshot. `redactSnapshot` strips the signed carrier URL tokens
// before a snapshot is saved for offline re-evaluation (verify-live.sh --save-snapshot/--snapshot).
// Import-free: scripts/deploy/lib.sh concatenates it after ops-client.mjs.

export function parseEnvLines(text) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

function settle(promise) {
  return promise.then(
    (value) => value,
    (error) => ({ error: error.message }),
  );
}

/** The inbound and status URLs the console renders for one carrier binding. */
export function carrierTargets(items) {
  const url = (purpose) => items?.find((item) => item.purpose === purpose)?.url ?? null;
  return { inbound: url('inbound'), status: url('status') };
}

export async function collectLiveSnapshot(input) {
  const { session, twilio, endpoints, probe, ops } = input;
  const base = (
    ops.OVO_OPS_PUBLIC_PROBE_BASE ||
    input.apiEnv.OVO_MEDIA_PUBLIC_BASE_URL ||
    ''
  ).replace(/\/$/, '');
  const snapshot = { mode: input.mode, apiEnv: input.apiEnv, serviceEnv: input.serviceEnv };
  snapshot.workers = {};
  for (const [name, url] of Object.entries(endpoints.workers))
    snapshot.workers[name] = await settle(probe.json(url).then((reply) => reply.body ?? {}));
  snapshot.dispatcher = await settle(
    probe.json(endpoints.dispatcher).then((reply) => reply.body ?? {}),
  );
  snapshot.publicHealth = base
    ? await probe.http(`${base}/ovo-gateway-health`)
    : { error: 'no public base URL' };
  snapshot.capacity = await settle(session.get('/v1/operations/inbound/capacity'));
  const routes = await settle(session.get('/v1/operations/inbound/routes?limit=100'));
  snapshot.routes = routes.error ? routes : (routes.items ?? []);
  snapshot.releases = {};
  snapshot.carrierUrls = {};
  for (const route of Array.isArray(snapshot.routes) ? snapshot.routes : []) {
    if (!route.enabled) continue;
    snapshot.releases[route.releaseId] ??= await settle(
      session.get(`/v1/releases/${encodeURIComponent(route.releaseId)}`).then(async (release) => ({
        agentId: release.agentId,
        ...(await session.get(`/v1/agents/${encodeURIComponent(release.agentId)}/readiness`)),
      })),
    );
    if (route.carrierBindingId)
      snapshot.carrierUrls[route.carrierBindingId] ??= await settle(
        session
          .get(`/v1/provider-bindings/${encodeURIComponent(route.carrierBindingId)}/carrier-urls`)
          .then((reply) => carrierTargets(reply.items)),
      );
  }
  const inbound = Object.values(snapshot.carrierUrls).find((targets) => targets.inbound)?.inbound;
  snapshot.upgradeUrl =
    inbound && base ? `${base}${new URL(inbound).pathname.replace(/\/[^/]+$/, '/media')}` : null;
  snapshot.upgrade = snapshot.upgradeUrl ? await probe.upgrade(snapshot.upgradeUrl) : null;
  snapshot.twilio = {
    number: ops.OVO_OPS_TWILIO_NUMBER || null,
    fallbackUrl: ops.OVO_OPS_FALLBACK_URL || null,
  };
  if (twilio && snapshot.twilio.number)
    snapshot.twilio.current = await settle(twilio.find(snapshot.twilio.number));
  return snapshot;
}

/** A URL with its query (the signed token) replaced by a fingerprint that still tells URLs apart. */
export function redactUrl(url) {
  if (typeof url !== 'string' || !url.includes('?')) return url;
  let hash = 0x811c9dc5;
  for (const char of url) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${url.split('?', 1)[0]}?redacted-${hash.toString(16).padStart(8, '0')}`;
}

/** Carrier URLs carry signed query tokens; a saved snapshot keeps only a fingerprint of each. */
export function redactSnapshot(snapshot) {
  const copy = structuredClone(snapshot);
  for (const targets of Object.values(copy.carrierUrls ?? {}))
    for (const purpose of ['inbound', 'status'])
      if (targets[purpose]) targets[purpose] = redactUrl(targets[purpose]);
  const current = copy.twilio?.current;
  if (current)
    for (const field of ['voiceUrl', 'statusCallback', 'voiceFallbackUrl'])
      current[field] = redactUrl(current[field]);
  if (copy.upgradeUrl) copy.upgradeUrl = redactUrl(copy.upgradeUrl);
  return copy;
}
