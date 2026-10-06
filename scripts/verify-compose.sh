#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# OPS-7: `verify-compose.sh --live [options]` adds the live checks (scripts/ops/verify-live.sh,
# which runs this script first without --live).
if [[ ${1:-} == --live ]]; then
  shift
  exec "$ROOT_DIR/scripts/ops/verify-live.sh" "$@"
fi
ENV_FILE=${1:-$ROOT_DIR/infra/compose/.env}
COMPOSE_FILE=$ROOT_DIR/infra/compose/compose.yaml

[[ -f $ENV_FILE ]] || {
  echo "Missing Compose environment: $ENV_FILE" >&2
  exit 2
}

bad_services=()
service_count=0
while IFS=$'\t' read -r service state health; do
  [[ -n $service ]] || continue
  service_count=$((service_count + 1))
  if [[ $state != running || $health != healthy ]]; then
    bad_services+=("$service")
  fi
done < <(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -a \
  --format '{{.Service}}\t{{.State}}\t{{.Health}}')
if ((${#bad_services[@]})); then
  echo "Unhealthy Compose services: ${bad_services[*]}" >&2
  exit 1
fi
((service_count > 0)) || { echo 'No Compose services are running' >&2; exit 1; }

# Carrier credentials belong in the credential store; an env carrier binding (OPS-2) is either a
# placeholder that earns silent carrier 403s or a second, unaudited live credential.
for service in api gateway worker-1 worker-2; do
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$service" \
    node --input-type=module - "$service" <<'NODE'
const service = process.argv[2];
const raw = process.env.OVO_CARRIER_ENV_BINDINGS;
const bindings = raw === undefined ? {} : JSON.parse(raw);
if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
  throw new Error(`${service}: OVO_CARRIER_ENV_BINDINGS must be a JSON object`);
if (Object.keys(bindings).length)
  throw new Error(`${service}: Compose must not configure an env carrier binding (${Object.keys(bindings).join(', ')})`);
if (process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_AUTH_TOKEN)
  throw new Error(`${service}: TWILIO_* must not reach the container`);
NODE
done

# Console sign-in (OPS-15 retires the bootstrap seed password after its first sign-in): the
# OVO_OPS_ADMIN_* account from the calling shell or the .env.ops beside the Compose environment,
# as scripts/deploy and scripts/ops use; without one, the seed administrator. The credentials reach
# the container on stdin, never on a command line.
OPS_ENV_FILE=${OPS_ENV_FILE:-$(dirname "$ENV_FILE")/.env.ops}
ops_value() {
  [[ -f $OPS_ENV_FILE ]] || return 0
  sed -n "s/^$1=//p" "$OPS_ENV_FILE" | tail -n 1
}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
ADMIN_EMAIL=${OVO_OPS_ADMIN_EMAIL:-$(ops_value OVO_OPS_ADMIN_EMAIL)}
ADMIN_PASSWORD=${OVO_OPS_ADMIN_PASSWORD:-$(ops_value OVO_OPS_ADMIN_PASSWORD)}

{
  printf "const opsAdmin = { email: Buffer.from('%s', 'base64').toString(), password: Buffer.from('%s', 'base64').toString() };\n" \
    "$(b64 "$ADMIN_EMAIL")" "$(b64 "$ADMIN_PASSWORD")"
  cat <<'NODE'
const apiBase = 'http://127.0.0.1:4000';
const consoleBase = 'http://console:3000';
const admin = opsAdmin.email
  ? opsAdmin
  : { email: process.env.OVO_SEED_ADMIN_EMAIL, password: process.env.OVO_SEED_ADMIN_PASSWORD };
const who = opsAdmin.email ? 'Ops administrator (OVO_OPS_ADMIN_EMAIL)' : 'Seed administrator';
const localHttp = process.env.OVO_ALLOW_LOCAL_HTTP === 'true';
if (process.env.OVO_FIXTURE_TEST_CALLS !== 'true')
  throw new Error('Fixture test calls must be explicitly enabled in the Compose API');
if (!process.env.OVO_MEDIA_PUBLIC_BASE_URL?.startsWith('https://'))
  throw new Error('Compose media public base URL must use HTTPS');
if (!process.env.OVO_INBOUND_ROUTE_SECRET || process.env.OVO_INBOUND_ROUTE_SECRET.length < 32)
  throw new Error('Compose inbound route secret is missing or too short');
const health = await fetch(`${apiBase}/health`);
if (!health.ok) throw new Error(`API health returned ${health.status}`);
const consoleResponse = await fetch(consoleBase);
if (!consoleResponse.ok) throw new Error(`Console returned ${consoleResponse.status}`);

const login = await fetch(`${consoleBase}/api/v1/auth/session`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: consoleBase,
    // A public installation terminates TLS at the host reverse proxy; the console forwards this.
    ...(localHttp ? {} : { 'x-forwarded-proto': 'https' }),
  },
  body: JSON.stringify(admin),
});
if (!login.ok)
  throw new Error(
    `${who} sign-in returned ${login.status}` +
      (opsAdmin.email ? '' : '; once the seed password is changed, set OVO_OPS_ADMIN_EMAIL and OVO_OPS_ADMIN_PASSWORD in infra/compose/.env.ops'),
  );
const { passwordChangeRequired } = await login.clone().json().catch(() => ({}));
const setCookie = login.headers.get('set-cookie');
if (localHttp && /;\s*Secure(?:;|$)/iu.test(setCookie ?? ''))
  throw new Error('Loopback HTTP sign-in issued a Secure cookie');
if (!localHttp && !/;\s*Secure(?:;|$)/iu.test(setCookie ?? ''))
  throw new Error('TLS sign-in did not issue a Secure cookie');
const cookie = setCookie?.split(';', 1)[0];
if (!cookie) throw new Error(`${who} sign-in did not issue a session cookie`);
const identity = await fetch(`${consoleBase}/api/v1/auth/me`, { headers: { cookie } });
if (!identity.ok) throw new Error(`Authenticated identity check returned ${identity.status}`);
if (passwordChangeRequired) {
  // The session reaches only the password-change routes, so the team directory is not readable.
  if (opsAdmin.email)
    throw new Error('The ops administrator must change its password in the console first (OPS-15)');
  console.log('Seed administrator signed in with the bootstrap password: change it in the console, then add an ops administrator as OVO_OPS_ADMIN_* in infra/compose/.env.ops.');
} else {
  const users = await fetch(`${consoleBase}/api/v1/users`, { headers: { cookie } });
  if (!users.ok) throw new Error(`Team users check returned ${users.status}`);
  const userItems = (await users.json()).items;
  if (!Array.isArray(userItems) || !userItems.some((user) => user.email === admin.email && user.role === 'admin'))
    throw new Error(`${who} is missing from the team directory as an admin`);
}

console.log(`Compose verification passed: ${process.env.OVO_EXPECTED_SERVICE_COUNT} services healthy, console proxy and API reachable, ${opsAdmin.email ? 'ops' : 'seed'} administrator authenticated.`);
NODE
} | docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e OVO_EXPECTED_SERVICE_COUNT="$service_count" api node --input-type=module -

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T dispatcher \
  node --input-type=module - <<'NODE'
if (process.env.OVO_CAPACITY_SIGNAL !== 'log')
  throw new Error('Compact Compose must log capacity signals without writing ECS desired count');
// Inbound readiness is reported while admission is still off (OPS-4); it fails only once enabled.
const { inbound } = await (await fetch('http://127.0.0.1:4002/health')).json();
if (!inbound) throw new Error('Dispatcher has not reported inbound readiness yet; rerun shortly');
const summary = `${inbound.readyWorkers} ready worker(s), ${inbound.readyProtected} protected slot(s), warm floor ${inbound.warmFloor}`;
console.log(`Inbound readiness: ${inbound.ready ? 'ready' : 'NOT ready'}, admission ${inbound.admissionEnabled ? 'enabled' : 'disabled'}; ${summary}.`);
for (const reason of inbound.reasons) console.log(`  - ${reason}`);
if (inbound.admissionEnabled && !inbound.ready)
  throw new Error('Inbound admission is enabled but no protected slot is ready');
NODE
