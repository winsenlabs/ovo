// OPS-7: "will the number answer?" `evaluateLive` turns a snapshot of the running stack (see
// live-collect.mjs) into pass/fail checks. Evaluation is pure, so a recorded snapshot can be
// re-checked offline: scripts/ops/verify-live.sh --snapshot FILE.
// Import-free: scripts/deploy/lib.sh concatenates it after ops-client.mjs.

const LIVE_FLAGS = {
  api: { OVO_LIVE_DIAL_ENABLED: 'true' },
  gateway: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
  dispatcher: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
  worker: {
    OVO_LIVE_DIAL_ENABLED: 'true',
    OVO_INBOUND_CAPACITY_ENABLED: 'true',
    OVO_TRANSPORT_CERTIFIED: 'true',
  },
};

export const LIVE_SERVICE_FLAGS = LIVE_FLAGS;

/** `NAME=value` lines, as `printenv` prints them, to an object. */

function check(results, id, status, message) {
  results.push({ id, status, message });
}

function flagChecks(results, snapshot) {
  const wrong = [];
  const services = { api: snapshot.apiEnv, ...snapshot.serviceEnv };
  for (const [service, values] of Object.entries(services)) {
    const expected = LIVE_FLAGS[service.startsWith('worker-') ? 'worker' : service] ?? {};
    for (const [name, value] of Object.entries(expected))
      if ((values ?? {})[name] !== value)
        wrong.push(`${service} ${name}=${(values ?? {})[name] ?? '<unset>'} (want ${value})`);
  }
  check(
    results,
    'live-flags',
    wrong.length ? 'fail' : 'pass',
    wrong.length
      ? `running containers disagree: ${wrong.join('; ')}`
      : 'live flags are on in every running container',
  );
}

function publicChecks(results, snapshot) {
  const raw = snapshot.apiEnv.OVO_MEDIA_PUBLIC_BASE_URL ?? '';
  let problem = null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') problem = 'must use https';
    else if (url.pathname !== '/' || url.search)
      problem = 'must be an origin with no path or query';
    else if (/(\.invalid|\.example|example\.com)$/.test(url.hostname))
      problem = 'is still the bootstrap placeholder';
  } catch {
    problem = 'is not a URL';
  }
  check(
    results,
    'public-base-url',
    problem ? 'fail' : 'pass',
    problem ? `OVO_MEDIA_PUBLIC_BASE_URL ${problem}` : `carriers reach ${raw}`,
  );

  const health = snapshot.publicHealth ?? {};
  if (health.status === 200 && health.body?.ready === true)
    check(
      results,
      'public-tls',
      'pass',
      'the public origin serves a valid certificate and reaches a ready gateway',
    );
  else
    check(
      results,
      'public-tls',
      'fail',
      health.error
        ? `the public origin is unreachable or its certificate is invalid (${health.error})`
        : health.status === undefined
          ? 'the public origin was not probed'
          : health.status === 200
            ? 'the gateway answered through the public origin but is not ready (draining?)'
            : `GET /ovo-gateway-health returned ${health.status}; route it to the gateway (infra/caddy/Caddyfile.template)`,
    );

  const upgrade = snapshot.upgrade;
  if (!upgrade)
    check(
      results,
      'wss-upgrade',
      'warn',
      'no enabled carrier route, so the WSS upgrade path was not probed',
    );
  else if (upgrade.status === 401 || upgrade.status === 403 || upgrade.status === 101)
    check(
      results,
      'wss-upgrade',
      'pass',
      `an unsigned upgrade reached the gateway's authenticated WSS handler (${upgrade.status})`,
    );
  else
    check(
      results,
      'wss-upgrade',
      'fail',
      upgrade.error
        ? `the WSS upgrade failed (${upgrade.error})`
        : upgrade.status === 426
          ? 'the proxy answered 426: it does not pass WebSocket upgrades to the gateway'
          : upgrade.status === 404
            ? 'the upgrade arrived as plain HTTP (404): the proxy strips Upgrade/Connection or misroutes /carriers/*'
            : `the WSS upgrade returned ${upgrade.status}`,
    );
}

function capacityChecks(results, snapshot) {
  const states = Object.entries(snapshot.workers ?? {}).map(([name, body]) => [
    name,
    body.state ?? `unreachable (${body.error})`,
  ]);
  const broken = states.filter(([, state]) => !['ready', 'active', 'reserved'].includes(state));
  const ready = states.filter(([, state]) => state === 'ready');
  const summary = states.map(([name, state]) => `${name}=${state}`).join(', ');
  if (!states.length) check(results, 'workers', 'fail', 'no worker reported its state');
  else
    check(
      results,
      'workers',
      broken.length ? 'fail' : ready.length ? 'pass' : 'warn',
      broken.length
        ? `workers not live: ${summary}`
        : ready.length
          ? `workers: ${summary}`
          : `every worker holds a call right now: ${summary}`,
    );

  const inbound = snapshot.dispatcher?.inbound;
  const protectedSlots = Math.max(
    inbound?.readyProtected ?? 0,
    snapshot.capacity?.readyProtected ?? 0,
  );
  check(
    results,
    'protected-capacity',
    inbound?.ready && protectedSlots >= 1 ? 'pass' : 'fail',
    inbound
      ? `dispatcher inbound ${inbound.ready ? 'ready' : 'NOT ready'}, ${protectedSlots} protected slot(s)${inbound.reasons?.length ? `: ${inbound.reasons.join('; ')}` : ''}`
      : `the dispatcher reported no inbound readiness (${snapshot.dispatcher?.error ?? 'missing'})`,
  );
}

function routeChecks(results, snapshot) {
  if (!Array.isArray(snapshot.routes)) {
    check(
      results,
      'routes',
      'fail',
      `inbound routes could not be read (${snapshot.routes?.error})`,
    );
    return [];
  }
  const enabled = snapshot.routes.filter((route) => route.enabled);
  const unbound = enabled.filter((route) => !route.carrierBindingId);
  check(
    results,
    'routes',
    enabled.length && !unbound.length ? 'pass' : 'fail',
    !enabled.length
      ? 'no enabled inbound route'
      : unbound.length
        ? `routes without a carrier binding: ${unbound.map((route) => route.phoneNumber).join(', ')}`
        : `enabled routes: ${enabled.map((route) => route.phoneNumber).join(', ')}`,
  );
  const blocked = [];
  for (const route of enabled) {
    const readiness = snapshot.releases?.[route.releaseId];
    if (!readiness?.liveReady)
      blocked.push(
        `${route.phoneNumber} → release ${route.releaseId}: ${readiness?.error ?? ((readiness?.liveBlockers ?? readiness?.blockers ?? []).join('; ') || 'not live-ready')}`,
      );
  }
  if (enabled.length)
    check(
      results,
      'releases-live-ready',
      blocked.length ? 'fail' : 'pass',
      blocked.length
        ? `not live-ready: ${blocked.join(' | ')}`
        : 'every routed release is live-ready',
    );
  return enabled;
}

function numberChecks(results, snapshot, enabled) {
  const { number, fallbackUrl, current } = snapshot.twilio ?? {};
  if (snapshot.mode === 'pre-switch') {
    check(results, 'carrier-number', 'skip', 'checked after the number is switched');
    return;
  }
  if (!current) {
    check(
      results,
      'carrier-number',
      'skip',
      'set OVO_OPS_TWILIO_* in infra/compose/.env.ops to compare the number with the carrier URLs',
    );
    return;
  }
  if (current.error) {
    check(results, 'carrier-number', 'fail', `Twilio lookup failed: ${current.error}`);
    return;
  }
  const route = enabled.find((item) => item.phoneNumber === number);
  const targets = route && snapshot.carrierUrls?.[route.carrierBindingId];
  const wrong = [];
  if (!targets || targets.error)
    wrong.push(`no carrier URLs for ${number} (${targets?.error ?? 'no enabled route'})`);
  else {
    if (current.voiceUrl !== targets.inbound)
      wrong.push(
        `Voice URL is ${current.voiceUrl === fallbackUrl ? 'the fallback (live is off)' : 'not the console inbound URL'}`,
      );
    if (current.statusCallback !== targets.status)
      wrong.push('status callback is not the console status URL');
  }
  check(
    results,
    'carrier-number',
    wrong.length ? 'fail' : 'pass',
    wrong.length ? `${number}: ${wrong.join('; ')}` : `${number} points at this stack`,
  );
  if (fallbackUrl && current.voiceFallbackUrl !== fallbackUrl)
    check(
      results,
      'carrier-fallback',
      'warn',
      `${number} has no Voice fallback URL to OVO_OPS_FALLBACK_URL; an outage would be silent`,
    );
}

export function evaluateLive(snapshot) {
  const results = [];
  check(
    results,
    'local-http-off',
    snapshot.apiEnv.OVO_ALLOW_LOCAL_HTTP === 'false' ? 'pass' : 'fail',
    snapshot.apiEnv.OVO_ALLOW_LOCAL_HTTP === 'false'
      ? 'the running API requires TLS'
      : `the running API has OVO_ALLOW_LOCAL_HTTP=${snapshot.apiEnv.OVO_ALLOW_LOCAL_HTTP ?? '<unset>'}; a public API must set false`,
  );
  flagChecks(results, snapshot);
  publicChecks(results, snapshot);
  capacityChecks(results, snapshot);
  numberChecks(results, snapshot, routeChecks(results, snapshot));
  return results;
}

export function reportLive(results, write = console.log) {
  for (const result of results)
    write(`${result.status.toUpperCase().padEnd(4)} ${result.id}: ${result.message}`);
  const failed = results.filter((result) => result.status === 'fail');
  write(
    failed.length
      ? `Live verification FAILED: ${failed.map((result) => result.id).join(', ')}`
      : 'Live verification passed.',
  );
  return failed.length === 0;
}
