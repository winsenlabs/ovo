// Terraform check (§13.7, `pnpm check:terraform`, not part of lint): fmt -check, init -backend=false
// and validate, with the local binary, else the hashicorp/terraform:1.10 image, else SKIPPED (exit 0).
// It runs on a temporary copy, so .terraform/ and lock files never land in the tree.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf('--dir');
const source = path.resolve(dirIndex >= 0 ? argv[dirIndex + 1] : 'infra/terraform');
const terraformBin = process.env.OVO_TERRAFORM_BIN ?? 'terraform';
const dockerBin = process.env.OVO_DOCKER_BIN ?? 'docker';
const IMAGE = 'hashicorp/terraform:1.10';

const works = (bin, args) => {
  const result = spawnSync(bin, args, { stdio: 'ignore', timeout: 20_000 });
  return !result.error && result.status === 0;
};

function runner() {
  if (works(terraformBin, ['version']))
    return { label: terraformBin, run: (dir, args) => [terraformBin, [`-chdir=${dir}`, ...args]] };
  if (works(dockerBin, ['info']))
    return {
      label: `${dockerBin} ${IMAGE}`,
      run: (dir, args) => [
        dockerBin,
        ['run', '--rm', '-v', `${dir}:/w`, '-w', '/w', IMAGE, ...args],
      ],
    };
  return undefined;
}

if (!existsSync(source)) {
  console.log(`SKIPPED: ${path.relative(process.cwd(), source)} does not exist`);
  process.exit(0);
}
const chosen = runner();
if (!chosen) {
  console.log(
    'SKIPPED: terraform is not installed and docker is unavailable; infra is covered by the static contract test only.',
  );
  process.exit(0);
}

// Docker Desktop and colima share the home directory with their VM, but not the system temp dir,
// so the copy lives under node_modules/.cache (git-ignored) and is removed afterwards.
const cache = path.resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(
  path.join(chosen.label === terraformBin ? tmpdir() : cache, 'ovo-terraform-'),
);
let failed = false;
try {
  cpSync(source, work, { recursive: true, filter: (file) => path.basename(file) !== '.terraform' });
  if (!readdirSync(work).some((file) => file.endsWith('.tf')))
    throw new Error(`no .tf files in ${source}`);
  if (chosen.label !== terraformBin) {
    // Fail loudly when the VM cannot see the copy (the container would validate an empty dir).
    const probe = spawnSync(
      dockerBin,
      ['run', '--rm', '-v', `${work}:/w`, '--entrypoint', 'ls', IMAGE, '/w'],
      {
        encoding: 'utf8',
      },
    );
    if (!/\.tf\b/.test(probe.stdout ?? ''))
      throw new Error(`docker cannot see ${work}; share it with the VM`);
  }
  for (const args of [
    ['fmt', '-check', '-recursive', '-diff'],
    ['init', '-backend=false', '-input=false', '-no-color'],
    ['validate', '-no-color'],
  ]) {
    const [bin, full] = chosen.run(work, args);
    console.log(`$ terraform ${args.join(' ')} (${chosen.label})`);
    const result = spawnSync(bin, full, { stdio: 'inherit', timeout: 600_000 });
    if (result.error || result.status !== 0) {
      console.error(
        `terraform ${args[0]} failed${result.error ? `: ${result.error.message}` : ''}`,
      );
      failed = true;
      break;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('Terraform fmt, init and validate passed.');
