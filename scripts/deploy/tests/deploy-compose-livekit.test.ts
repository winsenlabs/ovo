// deploy-compose.sh with OVO_LIVEKIT_ENABLED (Wave 17): the room server joins the deploy only behind
// the flag, its config is rendered from the environment before Compose runs, and only an image
// change recreates it, because a restart drops every live human call.
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from '../../ops/tests/fake-stack.ts';
import { DIGEST, cleanups, fixture, pins } from './deploy-fixture.ts';

afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const composeProfiles = (state: string) =>
  readFileSync(`${state}.profiles`, 'utf8').split('\n').filter(Boolean);
const IMAGE = 'livekit/livekit-server:v1.13.9';
const LOCAL_PROFILES = 'local-postgres,local-queue';

function setEnv(file: string, key: string, value: string) {
  const text = readFileSync(file, 'utf8');
  const line = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(
    file,
    line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}\n${key}=${value}\n`,
  );
}

function roomFixture(
  patch: Record<string, string> = {},
  dockerState: Record<string, unknown> = {},
) {
  const fx = fixture(dockerState);
  setEnv(fx.envFile, 'OVO_LIVEKIT_ENABLED', 'true');
  for (const [key, value] of Object.entries(patch)) setEnv(fx.envFile, key, value);
  const config = join(fx.repo, 'infra/compose/livekit.yaml');
  return { ...fx, config, profiles: () => composeProfiles(fx.box.env.FAKE_DOCKER_STATE) };
}

describe('deploy-compose.sh with the room server (Wave 17)', () => {
  it('changes nothing for the room server while the flag is off', async () => {
    const { box, deploy, envFile, ups, repo } = fixture();
    expect(readFileSync(envFile, 'utf8')).toContain('OVO_LIVEKIT_ENABLED=false\n');
    expect((await deploy('--images', pins(box.dir), '--skip-verify')).code).toBe(0);
    expect(box.dockerLog().filter((line) => line.includes('livekit'))).toEqual([]);
    expect(ups().at(-1)).toBe('-d --wait --remove-orphans');
    expect(new Set(composeProfiles(box.env.FAKE_DOCKER_STATE))).toEqual(new Set(['-']));
    expect(existsSync(join(repo, 'infra/compose/livekit.yaml'))).toBe(false);
  });

  it('bootstraps the room settings off, with a generated key pair that a rerun keeps', () => {
    const { envFile } = fixture();
    const value = (key: string) =>
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith(`${key}=`))
        .map((line) => line.slice(key.length + 1));
    expect(value('OVO_LIVEKIT_ENABLED')).toEqual(['false']);
    expect(value('OVO_LIVEKIT_PUBLIC_ENABLED')).toEqual(['false']);
    expect(value('OVO_HUMAN_QUEUE_ENABLED')).toEqual(['false']);
    expect(value('OVO_HUMAN_QUEUE_WEBHOOK_ENABLED')).toEqual(['false']);
    expect(value('OVO_LIVEKIT_API_KEY')[0]).toMatch(/^ovo[0-9a-f]{12}$/);
    expect(value('OVO_LIVEKIT_API_SECRET')[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders the owner-only config, adds the livekit profile and creates the server after the gateway', async () => {
    const { box, deploy, ups, profiles, config } = roomFixture();
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.code).toBe(0);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const rendered = readFileSync(config, 'utf8');
    expect(rendered).toContain('bind_addresses:\n  - "127.0.0.1"\n  - "172.29.240.1"\n');
    expect(rendered).toContain('node_ip: "127.0.0.1"');
    expect(box.dockerLog().some((line) => line.endsWith('pull livekit'))).toBe(true);
    expect(ups().slice(-3)).toEqual([
      '-d --no-deps --wait gateway',
      '-d --no-deps --wait --force-recreate livekit',
      '-d --wait --remove-orphans --no-recreate',
    ]);
    expect(new Set(profiles())).toEqual(new Set([`${LOCAL_PROFILES},livekit`]));
  });

  it('adds both profiles when SIP is on too, after the profiles the environment already selects', async () => {
    const { box, deploy, profiles, envFile, repo } = roomFixture();
    setEnv(envFile, 'OVO_SIP_ENABLED', 'true');
    cpSync(
      join(ROOT, 'infra/compose/sip-trunks.example.json'),
      join(repo, 'infra/compose/sip-trunks.json'),
    );
    const run = await deploy('--images', pins(box.dir, 'b2', true), '--skip-verify');
    expect(run.code).toBe(0);
    expect(new Set(profiles())).toEqual(new Set([`${LOCAL_PROFILES},sip,livekit`]));
  });

  it('leaves a running room server alone when its image did not change', async () => {
    const id = DIGEST('9');
    const { box, deploy, ups, setDocker } = roomFixture();
    setDocker({
      containers: { livekit: 'c-lk' },
      containerImages: { 'c-lk': id },
      imageIds: { [IMAGE]: id },
    });
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('livekit image unchanged: left running with its calls');
    expect(run.stderr).toContain('needs --recreate-livekit');
    expect(ups().filter((args) => args.endsWith('livekit'))).toEqual([]);
    expect(ups().at(-1)).toBe('-d --wait --remove-orphans --no-recreate');
  });

  it('--recreate-livekit applies a new key pair to an unchanged server', async () => {
    const id = DIGEST('9');
    const { box, deploy, ups, setDocker, config } = roomFixture({
      OVO_LIVEKIT_API_KEY: 'rotatedkey1',
      OVO_LIVEKIT_API_SECRET: 'r'.repeat(48),
    });
    setDocker({
      containers: { livekit: 'c-lk' },
      containerImages: { 'c-lk': id },
      imageIds: { [IMAGE]: id },
    });
    const run = await deploy('--images', pins(box.dir), '--recreate-livekit', '--skip-verify');
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('image unchanged');
    expect(readFileSync(config, 'utf8')).toContain('"rotatedkey1": "' + 'r'.repeat(48) + '"');
    expect(ups().slice(-2)).toEqual([
      '-d --no-deps --wait --force-recreate livekit',
      '-d --wait --remove-orphans --no-recreate',
    ]);
  });

  it('recreates the server when its image changed', async () => {
    const { box, deploy, ups, setDocker } = roomFixture();
    setDocker({
      containers: { livekit: 'c-lk' },
      containerImages: { 'c-lk': DIGEST('8') },
      imageIds: { [IMAGE]: DIGEST('9') },
    });
    expect((await deploy('--images', pins(box.dir), '--skip-verify')).code).toBe(0);
    expect(ups()).toContain('-d --no-deps --wait --force-recreate livekit');
  });

  it('keeps --recreate-livekit across the re-exec of a --ref deploy', async () => {
    const { box, deploy, ups, second } = roomFixture();
    const run = await deploy(
      '--ref',
      second,
      '--images',
      pins(box.dir),
      '--recreate-livekit',
      '--skip-verify',
    );
    expect(run.code).toBe(0);
    expect(ups()).toContain('-d --no-deps --wait --force-recreate livekit');
  });

  it('refuses --recreate-livekit while the room server is off, before touching docker', async () => {
    const { box, deploy } = fixture();
    const run = await deploy('--images', pins(box.dir), '--recreate-livekit', '--skip-verify');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--recreate-livekit needs OVO_LIVEKIT_ENABLED=true');
    expect(box.dockerLog()).toEqual([]);
  });

  it('stops before Compose when the room settings cannot be rendered', async () => {
    const { box, deploy, ups } = roomFixture({ OVO_LIVEKIT_PUBLIC_ENABLED: 'true' });
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('OVO_LIVEKIT_NODE_IP');
    expect(ups().filter((args) => args.includes('livekit'))).toEqual([]);
  });

  it('refuses a missing key pair with the bootstrap hint', async () => {
    const { box, deploy } = roomFixture({ OVO_LIVEKIT_API_KEY: '' });
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('OVO_LIVEKIT_ENABLED=true needs OVO_LIVEKIT_API_KEY');
  });
});
