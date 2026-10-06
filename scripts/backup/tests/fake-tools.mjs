#!/usr/bin/env node
// Stand-ins for `gcloud storage` (a local directory plays the bucket) and `age` (a reversible
// envelope, not encryption) in the backup tests. Invoked as `fake-tools.mjs gcloud|age ARGS…`;
// every call is logged to $FAKE_TOOLS_LOG.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_TOOLS_LOG ?? '/dev/null', `${tool} ${args.join(' ')}\n`);
const root = process.env.FAKE_GCS_ROOT;
const local = (url) => (url.startsWith('gs://') ? join(root, url.slice(5)) : url);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (tool === 'age') {
  const HEADER = 'FAKE-AGE ';
  if (args[0] === '-d') {
    const sealed = readFileSync(args[3]);
    const newline = sealed.indexOf(10);
    if (!sealed.subarray(0, newline).toString().startsWith(HEADER)) process.exit(1);
    process.stdout.write(sealed.subarray(newline + 1));
  } else {
    process.stdout.write(`${HEADER}${args[1]}\n`);
    process.stdout.write(readFileSync(0));
  }
} else if (tool === 'gcloud' && args[0] === 'storage') {
  const [command, ...rest] = args.slice(1);
  const paths = rest.filter((arg) => !arg.startsWith('--'));
  if (command === 'cp') {
    mkdirSync(dirname(local(paths[1])), { recursive: true });
    cpSync(local(paths[0]), local(paths[1]));
  } else if (command === 'ls') {
    const target = paths[0];
    if (target.endsWith('/**')) {
      const base = target.slice(0, -3);
      for (const file of walk(local(base))) console.log(`${base}/${relative(local(base), file)}`);
    } else if (!existsSync(local(target))) process.exit(1);
    else console.log(target);
  } else if (command === 'rsync') {
    const [source, destination] = paths;
    const target = local(destination);
    if (rest.includes('--delete-unmatched-destination-objects'))
      rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
  } else process.exit(2);
} else {
  writeFileSync(process.stderr.fd, `fake-tools: unsupported ${tool}\n`);
  process.exit(2);
}
