import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('survives an oversized worker frame before session admission', async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./worker-error-child.ts', import.meta.url))],
    { timeout: 5_000 },
  );
  expect(JSON.parse(result.stdout)).toEqual({ opened: 0, code: 1009 });
  expect(result.stderr).toBe('');
});
