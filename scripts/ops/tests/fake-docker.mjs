#!/usr/bin/env node
// A stand-in `docker` for the deploy/ops script tests: no container is ever touched. It logs each
// invocation to $FAKE_DOCKER_LOG and answers from the JSON state in $FAKE_DOCKER_STATE:
//   { env: {service: {NAME: value}}, workers: {service: state | [states…]},
//     fail: [argv substring…], baseVerify: "pass" | "fail", bakeDigests: true }
// `exec … node --input-type=module -` with the ops program on stdin runs it with the host node, so
// the program talks to the tests' fake console, workers and carrier servers.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => statePath && writeFileSync(statePath, JSON.stringify(state));
appendFileSync(process.env.FAKE_DOCKER_LOG ?? '/dev/null', `${args.join(' ')}\n`);

const joined = args.join(' ');
if ((state.fail ?? []).some((needle) => joined.includes(needle))) process.exit(1);

function runNode(rest) {
  const program = readFileSync(0, 'utf8');
  if (!program.startsWith('globalThis.ovoOpsInput')) {
    // verify-compose.sh's own heredoc checks: they target the real containers' loopback ports.
    if (state.baseVerify === 'fail') process.exit(1);
    process.stdout.write('base verification (fake) passed\n');
    process.exit(0);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-', ...rest], {
    input: program,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exit(result.status ?? 1);
}

const nodeAt = args.indexOf('node');
if (args[0] === 'run' && nodeAt > 0) runNode(args.slice(nodeAt + 3));

if (args[0] === 'compose') {
  const execAt = args.indexOf('exec');
  if (execAt > 0) {
    const service = args[execAt + 2];
    const command = args.slice(execAt + 3);
    if (command[0] === 'node' && command[1] === '--input-type=module') runNode(command.slice(3));
    if (command[0] === 'node' && command[1] === '-e') {
      const states = state.workers?.[service];
      const current = Array.isArray(states)
        ? states.length > 1
          ? states.shift()
          : states[0]
        : states;
      save();
      process.stdout.write(`${current ?? 'unreachable'}\n`);
      process.exit(0);
    }
    if (command[0] === 'sh') {
      const names = command.slice(4);
      for (const name of names)
        process.stdout.write(`${name}=${state.env?.[service]?.[name] ?? ''}\n`);
      process.exit(0);
    }
  }
  if (args.includes('ps')) {
    for (const service of state.services ?? [])
      process.stdout.write(`${service}\trunning\thealthy\n`);
    process.exit(0);
  }
  process.exit(0);
}

if (args[0] === 'buildx' && args[1] === 'bake') {
  const metadata = args[args.indexOf('--metadata-file') + 1];
  if (state.bakeDigests) {
    const digest = (seed) => `sha256:${seed.repeat(64)}`;
    writeFileSync(
      metadata,
      JSON.stringify(
        Object.fromEntries(
          ['api', 'console', 'gateway', 'dispatcher', 'worker', 'tools'].map((target, index) => [
            target,
            { 'containerimage.digest': digest('abcdef'[index]) },
          ]),
        ),
      ),
    );
  }
  process.exit(0);
}
process.exit(0);
