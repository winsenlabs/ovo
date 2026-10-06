// Imports a POC conversation map (`lib/flow.js`, checked against `docs/conversation-map.md`) into
// OVO flow JSON.
//
//   pnpm flow:import --preset creditmantri
//   pnpm flow:import <flow.js> --name <name> --context <text> [--constant agent=Ananya]...
//                    [--map <conversation-map.md>] [--out <flow.json>]
//
// Without --out the JSON goes to stdout. A map that disagrees with the import fails the run.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import prettier from 'prettier';
import { diffConversationMap } from './conversation-map.ts';
import { CREDITMANTRI_PRESET } from './creditmantri.ts';
import { importPocFlow, type PocFlowModule, type PocImportOptions } from './import-poc-flow.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: 'string' },
    name: { type: 'string' },
    context: { type: 'string' },
    constant: { type: 'string', multiple: true },
    map: { type: 'string' },
    out: { type: 'string' },
  },
});

async function run(): Promise<number> {
  let input: string, map: string | undefined, out: string | undefined;
  let options: PocImportOptions;
  if (values.preset) {
    if (values.preset !== 'creditmantri') throw new Error(`Unknown preset ${values.preset}`);
    ({ input, map, out, options } = CREDITMANTRI_PRESET);
  } else {
    if (positionals.length !== 1 || !values.name || !values.context)
      throw new Error('Usage: flow:import <flow.js> --name <name> --context <text> [options]');
    input = positionals[0]!;
    ({ map, out } = values);
    const source = await readFile(input);
    options = {
      name: values.name,
      context: values.context,
      constants: Object.fromEntries(
        (values.constant ?? []).map((pair) => {
          const at = pair.indexOf('=');
          if (at < 1) throw new Error(`--constant expects name=value, got ${pair}`);
          return [pair.slice(0, at), pair.slice(at + 1)];
        }),
      ),
      source: {
        importer: 'scripts/flow-import',
        from: input,
        sha256: createHash('sha256').update(source).digest('hex'),
      },
    };
  }
  const poc = (await import(pathToFileURL(input).href)) as PocFlowModule;
  const flow = importPocFlow(poc, options);
  if (map) {
    const differences = diffConversationMap(flow, await readFile(map, 'utf8'), options.constants);
    if (differences.length) {
      console.error(`Conversation map disagrees with ${input}:\n  ${differences.join('\n  ')}`);
      return 1;
    }
  }
  const style = await prettier.resolveConfig(out ?? 'flow.json');
  const json = await prettier.format(JSON.stringify(flow), { ...style, parser: 'json' });
  if (out) {
    await writeFile(out, json);
    console.error(
      `Wrote ${out}: ${Object.keys(flow.nodes).length} nodes, ${Object.keys(flow.listens).length} listens, ${Object.keys(flow.lines).length} lines.`,
    );
  } else process.stdout.write(json);
  return 0;
}

process.exitCode = await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
