// `pnpm lint` (§13): every code-hygiene gate in sequence, forwarding --only <prefix>... to each.
// All gates run even after a failure, so one run reports everything.
import { spawnSync } from 'node:child_process';

const GATES = [
  'check-architecture.mjs',
  'check-upstream.mjs',
  'check-module-size.mjs',
  'check-duplication.mjs',
  'check-provider-names.mjs',
  'check-capability-keys.mjs',
  'check-conformance.mjs',
];

const forwarded = process.argv.slice(2);
const failed = [];
for (const gate of GATES) {
  // Every gate gets every argument, including check-upstream.mjs: that gate checks the whole
  // repository and says so in its own output rather than having lint drop --only behind its back.
  const result = spawnSync(process.execPath, [`scripts/${gate}`, ...forwarded], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(gate);
}
if (failed.length) {
  console.error(`lint failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(
  `lint passed: ${GATES.length} gates${forwarded.length ? ` (${forwarded.join(' ')})` : ''}.`,
);
