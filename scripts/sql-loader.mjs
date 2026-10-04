import { readFile } from 'node:fs/promises';

/** Keep tsx development equivalent to the production bundler's SQL text loader. */
export async function load(url, context, nextLoad) {
  const location = new URL(url);
  if (location.protocol === 'file:' && location.pathname.endsWith('.sql')) {
    const sql = await readFile(location, 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(sql)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
