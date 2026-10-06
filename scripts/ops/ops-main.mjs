// Entry point of the concatenated ops program (see ops_program in scripts/deploy/lib.sh). It reads
// globalThis.ovoOpsInput, which the calling script writes on stdin ahead of the modules:
//   { command, ops: {OVO_OPS_*}, serviceEnv: {service: "NAME=value\n…"}, endpoints?, dryRun?,
//     mode?, snapshot?, emitSnapshot? }
// Commands: evaluate (offline), verify-live, live-on (both inside the API container), live-off and
// live-status (anywhere with network access to the carrier API).

const OPS_DEFAULT_ENDPOINTS = {
  console: 'http://console:3000',
  dispatcher: 'http://dispatcher:4002/health',
  workers: { 'worker-1': 'http://worker-1:4100/health', 'worker-2': 'http://worker-2:4100/health' },
};

async function opsMain(input) {
  const ops = input.ops ?? {};
  const log = (line) => console.log(line);
  const twilio = () =>
    twilioNumbers({
      apiBase: ops.OVO_OPS_TWILIO_API_BASE,
      accountSid: ops.OVO_OPS_TWILIO_ACCOUNT_SID,
      keySid: ops.OVO_OPS_TWILIO_API_KEY_SID,
      keySecret: ops.OVO_OPS_TWILIO_API_KEY_SECRET,
    });
  const number = () => {
    if (!/^\+[1-9]\d{6,14}$/.test(ops.OVO_OPS_TWILIO_NUMBER ?? ''))
      throw new Error('OVO_OPS_TWILIO_NUMBER must be an E.164 number such as +12025550123');
    return ops.OVO_OPS_TWILIO_NUMBER;
  };
  const serviceEnv = Object.fromEntries(
    Object.entries(input.serviceEnv ?? {}).map(([service, text]) => [service, parseEnvLines(text)]),
  );
  const apiEnv = serviceEnv.api ?? {};
  delete serviceEnv.api;
  const endpoints = { ...OPS_DEFAULT_ENDPOINTS, ...(input.endpoints ?? {}) };
  // A dedicated console account, never the seed administrator: since OPS-15 the bootstrap
  // OVO_SEED_ADMIN_PASSWORD only reaches the password-change routes, then stops working.
  const session = () => {
    if (
      ops.OVO_OPS_ADMIN_PASSWORD &&
      ops.OVO_OPS_ADMIN_PASSWORD === process.env.OVO_SEED_ADMIN_PASSWORD
    )
      throw new Error(
        'OVO_OPS_ADMIN_PASSWORD is the bootstrap seed password; use a console administrator with its own password',
      );
    return openConsoleSession({
      consoleBase: endpoints.console,
      email: ops.OVO_OPS_ADMIN_EMAIL,
      password: ops.OVO_OPS_ADMIN_PASSWORD,
      forwardedTls: apiEnv.OVO_ALLOW_LOCAL_HTTP !== 'true',
    });
  };

  switch (input.command) {
    case 'evaluate':
      return reportLive(evaluateLive(input.snapshot));
    case 'verify-live': {
      const snapshot = await collectLiveSnapshot({
        session: await session(),
        twilio: ops.OVO_OPS_TWILIO_ACCOUNT_SID ? twilio() : undefined,
        endpoints,
        apiEnv,
        serviceEnv,
        mode: input.mode ?? 'full',
        ops,
        probe: { json: opsJson, http: probeHttp, upgrade: probeUpgrade },
      });
      const ok = reportLive(evaluateLive(snapshot));
      if (input.emitSnapshot) log(`OVO_SNAPSHOT ${JSON.stringify(redactSnapshot(snapshot))}`);
      return ok;
    }
    case 'live-on': {
      const console_ = await session();
      const phone = number();
      const routes = (await console_.get('/v1/operations/inbound/routes?limit=100')).items ?? [];
      const route = routes.find((item) => item.enabled && item.phoneNumber === phone);
      if (!route?.carrierBindingId)
        throw new Error(`no enabled inbound route with a carrier binding for ${phone}`);
      const urls = await console_.get(
        `/v1/provider-bindings/${encodeURIComponent(route.carrierBindingId)}/carrier-urls`,
      );
      await switchNumber({
        direction: 'on',
        twilio: twilio(),
        number: phone,
        targets: carrierTargets(urls.items),
        fallbackUrl: ops.OVO_OPS_FALLBACK_URL,
        dryRun: input.dryRun === true,
        log,
      });
      return true;
    }
    case 'live-off':
      await switchNumber({
        direction: 'off',
        twilio: twilio(),
        number: number(),
        fallbackUrl: ops.OVO_OPS_FALLBACK_URL,
        dryRun: input.dryRun === true,
        log,
      });
      return true;
    case 'live-status': {
      const current = await twilio().find(number());
      const where = classifyNumber(current, { fallbackUrl: ops.OVO_OPS_FALLBACK_URL });
      // OVO's own carrier URLs carry signed tokens; any other URL is printed whole, to record it.
      const shown = (url) => (/\/carriers\//.test(url ?? '') ? redactUrl(url) : url);
      log(
        `${current.phoneNumber}: ${where === 'fallback' ? 'OFF (fallback TwiML)' : 'routed to'} ${shown(current.voiceUrl) ?? '<no Voice URL>'} (${current.voiceMethod ?? '?'})`,
      );
      log(`  voice fallback: ${shown(current.voiceFallbackUrl) ?? '<none>'}`);
      log(
        `  status callback: ${shown(current.statusCallback) ?? '<none>'} (${current.statusCallbackMethod ?? '?'})`,
      );
      return true;
    }
    default:
      throw new Error(`unknown ops command ${input.command}`);
  }
}

opsMain(globalThis.ovoOpsInput ?? {}).then(
  (ok) => {
    process.exitCode = ok ? 0 : 1;
  },
  (error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  },
);
