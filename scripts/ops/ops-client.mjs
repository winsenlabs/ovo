// HTTP clients for the ops scripts: the console API (as a signed-in administrator), the Twilio
// IncomingPhoneNumbers REST resource, and raw probes of the public origin. This is the only ops
// module with imports; scripts/deploy/lib.sh concatenates it with the import-free ones and runs
// the result from stdin inside the API container (or on the host for Twilio-only commands).
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

export async function opsJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, ok: response.ok, body, headers: response.headers };
}

/** Signs in through the console proxy exactly as a browser would (see verify-compose.sh). */
export async function openConsoleSession({ consoleBase, email, password, forwardedTls }) {
  if (!email || !password)
    throw new Error(
      'set OVO_OPS_ADMIN_EMAIL and OVO_OPS_ADMIN_PASSWORD in infra/compose/.env.ops (a console administrator other than the seed account)',
    );
  const login = await opsJson(`${consoleBase}/api/v1/auth/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: consoleBase,
      ...(forwardedTls ? { 'x-forwarded-proto': 'https' } : {}),
    },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`console sign-in returned ${login.status}`);
  // OPS-15: a password that fails the policy (or is the bootstrap seed one) only reaches the
  // password-change routes; every read below would answer 403 password_change_required.
  if (login.body?.passwordChangeRequired)
    throw new Error(
      'console sign-in needs a password change first: sign in to the console as OVO_OPS_ADMIN_EMAIL, change the password, and update .env.ops',
    );
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('console sign-in issued no session cookie');
  return {
    async get(path) {
      const reply = await opsJson(`${consoleBase}/api${path}`, { headers: { cookie } });
      if (!reply.ok) throw new Error(`GET ${path} returned ${reply.status}`);
      return reply.body;
    },
  };
}

const TWILIO_FIELDS = {
  voiceUrl: ['VoiceUrl', 'voice_url'],
  voiceMethod: ['VoiceMethod', 'voice_method'],
  voiceFallbackUrl: ['VoiceFallbackUrl', 'voice_fallback_url'],
  voiceFallbackMethod: ['VoiceFallbackMethod', 'voice_fallback_method'],
  statusCallback: ['StatusCallback', 'status_callback'],
  statusCallbackMethod: ['StatusCallbackMethod', 'status_callback_method'],
};

function twilioNumber(row) {
  const number = { sid: row.sid, phoneNumber: row.phone_number };
  for (const [field, [, json]] of Object.entries(TWILIO_FIELDS)) number[field] = row[json] ?? null;
  return number;
}

/**
 * Twilio's IncomingPhoneNumber resource (2010-04-01 API), confirmed 2026-10-06 against
 * https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource: list by
 * `PhoneNumber` under `incoming_phone_numbers`; update with form fields VoiceUrl, VoiceMethod,
 * VoiceFallbackUrl, VoiceFallbackMethod, StatusCallback, StatusCallbackMethod. Basic auth with an
 * API key SID and secret (or the Account SID and auth token).
 */
export function twilioNumbers({ apiBase, accountSid, keySid, keySecret }) {
  if (!accountSid || !keySid || !keySecret)
    throw new Error(
      'Twilio control needs OVO_OPS_TWILIO_ACCOUNT_SID, _API_KEY_SID and _API_KEY_SECRET',
    );
  const base = `${(apiBase || 'https://api.twilio.com').replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  const authorization = `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString('base64')}`;
  return {
    async find(phoneNumber) {
      const reply = await opsJson(
        `${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
        { headers: { authorization } },
      );
      if (!reply.ok) throw new Error(`Twilio number lookup returned ${reply.status}`);
      const row = reply.body?.incoming_phone_numbers?.find(
        (item) => item.phone_number === phoneNumber,
      );
      if (!row) throw new Error(`Twilio account has no number ${phoneNumber}`);
      return twilioNumber(row);
    },
    async update(sid, fields) {
      const form = new URLSearchParams();
      for (const [field, value] of Object.entries(fields)) form.set(TWILIO_FIELDS[field][0], value);
      const reply = await opsJson(`${base}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!reply.ok) throw new Error(`Twilio number update returned ${reply.status}`);
      return twilioNumber(reply.body);
    },
  };
}

/** GET a URL; never throws. TLS certificates are verified. */
export async function probeHttp(url) {
  try {
    const reply = await opsJson(url, { timeoutMs: 10_000 });
    return { status: reply.status, body: reply.body };
  } catch (error) {
    return { error: error.cause?.code ?? error.message };
  }
}

/** Sends a WebSocket upgrade and reports the status line (101, or the refusal); never throws. */
export function probeUpgrade(url, timeoutMs = 10_000) {
  const target = new URL(url.replace(/^ws/, 'http'));
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = request(target, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode });
    });
    req.on('response', (response) => {
      response.resume();
      resolve({ status: response.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ error: error.code ?? error.message }));
    req.end();
  });
}
