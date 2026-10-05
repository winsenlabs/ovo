#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e OVO_EXPECTED_SERVICE_COUNT="$service_count" api node --input-type=module - <<'NODE'
const apiBase = 'http://127.0.0.1:4000';
const consoleBase = 'http://console:3000';
const localHttp = process.env.OVO_ALLOW_LOCAL_HTTP === 'true';
if (process.env.OVO_FIXTURE_TEST_CALLS !== 'true')
  throw new Error('Fixture test calls must be explicitly enabled in the Compose API');
if (!process.env.OVO_MEDIA_PUBLIC_BASE_URL?.startsWith('https://'))
  throw new Error('Compose media public base URL must use HTTPS');
if (!process.env.OVO_INBOUND_ROUTE_SECRET || process.env.OVO_INBOUND_ROUTE_SECRET.length < 32)
  throw new Error('Compose inbound route secret is missing or too short');
const carrierBindings = JSON.parse(process.env.OVO_CARRIER_ENV_BINDINGS ?? '{}');
if (!carrierBindings || typeof carrierBindings !== 'object' || Array.isArray(carrierBindings))
  throw new Error('Compose carrier environment bindings must be an object');
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
  body: JSON.stringify({
    email: process.env.OVO_SEED_ADMIN_EMAIL,
    password: process.env.OVO_SEED_ADMIN_PASSWORD,
  }),
});
if (!login.ok) throw new Error(`Seed administrator sign-in returned ${login.status}`);
const setCookie = login.headers.get('set-cookie');
if (localHttp && /;\s*Secure(?:;|$)/iu.test(setCookie ?? ''))
  throw new Error('Loopback HTTP sign-in issued a Secure cookie');
if (!localHttp && !/;\s*Secure(?:;|$)/iu.test(setCookie ?? ''))
  throw new Error('TLS sign-in did not issue a Secure cookie');
const cookie = setCookie?.split(';', 1)[0];
if (!cookie) throw new Error('Seed administrator sign-in did not issue a session cookie');
const identity = await fetch(`${consoleBase}/api/v1/auth/me`, { headers: { cookie } });
if (!identity.ok) throw new Error(`Authenticated identity check returned ${identity.status}`);
const users = await fetch(`${consoleBase}/api/v1/users`, { headers: { cookie } });
if (!users.ok) throw new Error(`Team users check returned ${users.status}`);
const userItems = (await users.json()).items;
if (!Array.isArray(userItems) || !userItems.some((user) => user.email === process.env.OVO_SEED_ADMIN_EMAIL && user.role === 'admin'))
  throw new Error('Seed administrator is missing from the team directory');

console.log(`Compose verification passed: ${process.env.OVO_EXPECTED_SERVICE_COUNT} services healthy, console proxy and API reachable, seed administrator authenticated.`);
NODE

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T dispatcher \
  node --input-type=module - <<'NODE'
if (process.env.OVO_CAPACITY_SIGNAL !== 'log')
  throw new Error('Compact Compose must log capacity signals without writing ECS desired count');
NODE
