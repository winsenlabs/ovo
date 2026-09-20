import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export interface SourceIdentity {
  gitHead: string;
  gitBranch: string;
  gitDirty: boolean;
  sha256: {
    experimentSource: string;
    runtimeSource: string;
    focusedComponentSource: string;
    lockfile: string;
  };
}

export async function captureSourceIdentity(repositoryRoot: string): Promise<SourceIdentity> {
  const experimentFiles = await filesUnder(resolve(repositoryRoot, 'experiments/voice'), [
    'results',
    'node_modules',
  ]);
  const runtimeFiles = await filesUnder(resolve(repositoryRoot, 'packages/runtime'), [
    'node_modules',
  ]);
  const focusedFiles = (
    await Promise.all(
      [
        'packages/contracts',
        'packages/behaviors',
        'packages/plugin-inference',
        'packages/plugin-tools',
        'packages/plugin-voice',
      ].map((path) => filesUnder(resolve(repositoryRoot, path), ['node_modules', 'coverage'])),
    )
  ).flat();
  return {
    gitHead: git(repositoryRoot, 'rev-parse', 'HEAD'),
    gitBranch: git(repositoryRoot, 'branch', '--show-current'),
    gitDirty: git(repositoryRoot, 'status', '--porcelain').length > 0,
    sha256: {
      experimentSource: await hashFiles(repositoryRoot, experimentFiles),
      runtimeSource: await hashFiles(repositoryRoot, runtimeFiles),
      focusedComponentSource: await hashFiles(repositoryRoot, focusedFiles),
      lockfile: await hashFiles(repositoryRoot, [resolve(repositoryRoot, 'pnpm-lock.yaml')]),
    },
  };
}

function git(repositoryRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

async function filesUnder(directory: string, excludedDirectories: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.includes(entry.name))
        result.push(...(await filesUnder(path, excludedDirectories)));
    } else {
      result.push(path);
    }
  }
  return result.sort();
}

async function hashFiles(repositoryRoot: string, files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(relative(repositoryRoot, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
