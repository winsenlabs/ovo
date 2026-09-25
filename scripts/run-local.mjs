import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
loadEnvFile('.data/local.env');
const target = process.argv[2];
if (!['api', 'console'].includes(target)) throw new Error('Use api or console');
const child = spawn('pnpm', ['--filter', `@winsendotai/ovo-${target}`, 'dev'], {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
