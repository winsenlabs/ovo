import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from './fake-stack.ts';

const script = join(ROOT, 'scripts/ops/ensure-livekit-test-server.sh');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function stub(directory: string, name: string, body: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(env: Record<string, string>, args: string[] = []) {
  const bin = mkdtempSync(join(tmpdir(), 'ovo-lk-bin-'));
  dirs.push(bin);
  const result = spawnSync('bash', [script, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env },
    encoding: 'utf8',
  });
  return { ...result, bin, out: result.stdout.trim() };
}

const server = (version = '1.13.9') =>
  `[[ $1 == --version ]] && echo "livekit-server version ${version}"; exit 0`;

describe('ensure-livekit-test-server.sh', () => {
  it('uses OVO_E2E_LIVEKIT_BIN first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-lk-'));
    dirs.push(dir);
    const bin = stub(dir, 'livekit-server', server());
    const result = run({ OVO_E2E_LIVEKIT_BIN: bin });
    expect(result.status).toBe(0);
    expect(result.out).toBe(`bin ${bin}`);
  });

  it('refuses a broken OVO_E2E_LIVEKIT_BIN rather than falling back silently', () => {
    const result = run({ OVO_E2E_LIVEKIT_BIN: '/nonexistent/livekit-server' });
    expect(result.status).toBe(3);
    expect(result.out).toBe(
      'skip OVO_E2E_LIVEKIT_BIN=/nonexistent/livekit-server is not an executable livekit-server',
    );
  });

  it('finds livekit-server on PATH and notes a version other than the compose pin', () => {
    const probe = run({});
    stub(probe.bin, 'livekit-server', server('1.12.0'));
    const result = spawnSync('bash', [script], {
      env: { PATH: `${probe.bin}:/usr/bin:/bin`, HOME: probe.bin },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`bin ${join(probe.bin, 'livekit-server')}`);
    expect(result.stderr).toContain('is 1.12.0; compose pins 1.13.9');
  });

  it('says nothing about the version when it matches the pin', () => {
    const probe = run({});
    stub(probe.bin, 'livekit-server', server());
    const result = spawnSync('bash', [script], {
      env: { PATH: `${probe.bin}:/usr/bin:/bin`, HOME: probe.bin },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('skips with a reason when nothing is installed, and never installs without --install', () => {
    const probe = run({});
    stub(probe.bin, 'brew', 'echo brew-was-called >&2; exit 1');
    const result = spawnSync('bash', [script], {
      env: { PATH: `${probe.bin}:/usr/bin:/bin`, HOME: probe.bin },
      encoding: 'utf8',
    });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(/^skip no livekit-server on PATH/);
    expect(result.stderr).not.toContain('brew-was-called');
  });

  it('installs with brew only on request', () => {
    const probe = run({});
    stub(
      probe.bin,
      'brew',
      `echo "brew $*" >&2; cat > "${probe.bin}/livekit-server" <<'EOS'\n#!/bin/bash\n[[ $1 == --version ]] && echo "livekit-server version 1.13.9"\nEOS\nchmod +x "${probe.bin}/livekit-server"`,
    );
    const result = spawnSync('bash', [script, '--install'], {
      env: { PATH: `${probe.bin}:/usr/bin:/bin`, HOME: probe.bin },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('brew install livekit');
    expect(result.stdout.trim()).toBe(`bin ${join(probe.bin, 'livekit-server')}`);
  });

  it('never offers docker: the e2e starts a local binary, so a container would be unusable', () => {
    const probe = run({});
    stub(probe.bin, 'docker', 'exit 0');
    const result = spawnSync('bash', [script], {
      env: { PATH: `${probe.bin}:/usr/bin:/bin`, HOME: probe.bin, OVO_E2E_LIVEKIT_DOCKER: 'true' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(/^skip /);
  });

  it('is executable and prints its usage', () => {
    const result = run({}, ['--help']);
    expect(result.status).toBe(0);
    expect(result.out).toContain('Finds a LiveKit room server');
    expect(run({}, ['--bogus']).status).toBe(2);
  });
});
