import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = await collect(root);
const failures = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const nonblankLines = content.split('\n').filter((line) => line.trim()).length;
  const bytes = Buffer.byteLength(content);
  const lineCap = file.includes('/tests/') ? 500 : 400;
  if (nonblankLines > lineCap || bytes > 24 * 1024) {
    failures.push(`${file}: ${nonblankLines}/${lineCap} nonblank lines, ${bytes}/24576 bytes`);
  }
}

if (failures.length > 0) {
  throw new Error(`TypeScript size gate failed:\n${failures.join('\n')}`);
}

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'results')
        result.push(...(await collect(path)));
    } else if (extname(entry.name) === '.ts') {
      result.push(path);
    }
  }
  return result;
}
