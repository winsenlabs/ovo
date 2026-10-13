// deploy-compose.sh with OVO_SIP_ENABLED (Wave 11): the sip-gateway joins the deploy only behind
// the flag, and only an image change recreates it, because a restart drops every live SIP call.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from '../../ops/tests/fake-stack.ts';
import { DIGEST, cleanups, fixture, image, pins } from './deploy-fixture.ts';

afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** The COMPOSE_PROFILES of every compose call, as fake-docker.mjs recorded them (`-`: unset). */
const composeProfiles = (state: string) =>
  readFileSync(`${state}.profiles`, 'utf8').split('\n').filter(Boolean);

describe('deploy-compose.sh with SIP (Wave 11)', () => {
  const SIP_IMAGE = `reg.example/ovo/ovo-sip-gateway:b2@${DIGEST('7')}`;
  const LOCAL_PROFILES = 'local-postgres,local-queue';

  function sipFixture(dockerState: Record<string, unknown> = {}) {
    const fx = fixture(dockerState);
    const env = readFileSync(fx.envFile, 'utf8').replace(
      /^OVO_SIP_ENABLED=.*$/m,
      'OVO_SIP_ENABLED=true',
    );
    writeFileSync(fx.envFile, env);
    cpSync(
      join(ROOT, 'infra/compose/sip-trunks.example.json'),
      join(fx.repo, 'infra/compose/sip-trunks.json'),
    );
    const profiles = () => composeProfiles(fx.box.env.FAKE_DOCKER_STATE);
    return { ...fx, profiles };
  }

  it('changes nothing for SIP while the flag is off', async () => {
    const { box, deploy, envFile, ups } = fixture();
    expect(readFileSync(envFile, 'utf8')).toContain('OVO_SIP_ENABLED=false\n');
    expect((await deploy('--images', pins(box.dir), '--skip-verify')).code).toBe(0);
    expect(box.dockerLog().filter((line) => line.includes('sip'))).toEqual([]);
    expect(ups().at(-1)).toBe('-d --wait --remove-orphans');
    expect(new Set(composeProfiles(box.env.FAKE_DOCKER_STATE))).toEqual(new Set(['-']));
  });

  it('adds the sip profile to the environment profiles and creates the sip-gateway last', async () => {
    const { box, deploy, ups, profiles, envFile } = sipFixture();
    const run = await deploy('--images', pins(box.dir, 'b2', true), '--skip-verify');
    expect(run.code).toBe(0);
    expect(image(envFile, 'SIP_GATEWAY')).toBe(SIP_IMAGE);
    expect(
      box
        .dockerLog()
        .some((line) =>
          line.endsWith('pull api console gateway dispatcher worker-1 worker-2 sip-gateway'),
        ),
    ).toBe(true);
    expect(ups().slice(-3)).toEqual([
      '-d --no-deps --wait gateway',
      '-d --no-deps --wait sip-gateway',
      '-d --wait --remove-orphans --no-recreate',
    ]);
    expect(new Set(profiles())).toEqual(new Set([`${LOCAL_PROFILES},sip`]));
  });

  it('leaves a running sip-gateway alone when its image did not change', async () => {
    const id = DIGEST('9');
    const { box, deploy, ups, setDocker } = sipFixture();
    setDocker({
      containers: { 'sip-gateway': 'c-sip' },
      containerImages: { 'c-sip': id },
      imageIds: { [SIP_IMAGE]: id },
    });
    const run = await deploy('--images', pins(box.dir, 'b2', true), '--skip-verify');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('sip-gateway image unchanged: left running with its calls');
    expect(ups()).not.toContain('-d --no-deps --wait sip-gateway');
    expect(ups().at(-1)).toBe('-d --wait --remove-orphans --no-recreate');
  });

  it('recreates the sip-gateway, after the gateway, when its image changed', async () => {
    const { box, deploy, ups, setDocker } = sipFixture();
    setDocker({
      containers: { 'sip-gateway': 'c-sip' },
      containerImages: { 'c-sip': DIGEST('8') },
      imageIds: { [SIP_IMAGE]: DIGEST('9') },
    });
    expect((await deploy('--images', pins(box.dir, 'b2', true), '--skip-verify')).code).toBe(0);
    const order = ups();
    expect(order.indexOf('-d --no-deps --wait sip-gateway')).toBe(
      order.indexOf('-d --no-deps --wait gateway') + 1,
    );
  });

  it('refuses to deploy SIP without a trunk file or a sip-gateway image, before touching docker', async () => {
    const noTrunks = sipFixture();
    rmSync(join(noTrunks.repo, 'infra/compose/sip-trunks.json'));
    const missing = await noTrunks.deploy('--images', pins(noTrunks.box.dir, 'b2', true));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('missing SIP trunk file');
    expect(noTrunks.box.dockerLog()).toEqual([]);

    const noImage = sipFixture();
    const run = await noImage.deploy('--images', pins(noImage.box.dir), '--skip-verify');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('needs a sip-gateway image: build-images.sh --sip');
    expect(noImage.box.dockerLog()).toEqual([]);
  });

  it('builds the sip-gateway with the others on --build', async () => {
    const { box, deploy, envFile } = sipFixture();
    expect((await deploy('--build', '--skip-verify')).code).toBe(0);
    expect(
      box
        .dockerLog()
        .some((line) =>
          line.endsWith('build api console gateway dispatcher worker-1 worker-2 sip-gateway'),
        ),
    ).toBe(true);
    expect(image(envFile, 'SIP_GATEWAY') ?? 'ovo-sip-gateway:local').toBe('ovo-sip-gateway:local');
  });
});
