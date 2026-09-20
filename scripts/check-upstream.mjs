import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const lock = JSON.parse(await readFile('docs/research/deepseek-source-lock.json', 'utf8'));
for (const file of lock.files) {
  const hash = createHash('sha256')
    .update(await readFile(file.local))
    .digest('hex');
  if (hash !== (file.localSha256 ?? file.sha256))
    throw new Error(`Pinned upstream extraction changed: ${file.local}`);
}
console.log(`Verified ${lock.files.length} pinned DeepSeek source files at ${lock.commit}.`);
