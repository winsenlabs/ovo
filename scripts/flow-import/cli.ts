// Imports a POC conversation map (`lib/flow.js`, checked against `docs/conversation-map.md`) into
// the agent-config fields a flow needs: `flow`, `idle` and `variables`, as JSON.
//
//   pnpm flow:import --preset creditmantri
//   pnpm flow:import <flow.js> --context <text> [--constant agent=Ananya]... [--threshold 0.55]
//                    [--map <conversation-map.md>] [--out <flow.json>]
//
// Without --out the JSON goes to stdout. What the flow cannot express is listed on stderr. A map
// that disagrees with the import fails the run.
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
    context: { type: 'string' },
    constant: { type: 'string', multiple: true },
    threshold: { type: 'string' },
    map: { type: 'string' },
    out: { type: 'string' },
  },
});

function fromArguments(): { input: string; options: PocImportOptions } {
  if (positionals.length !== 1 || !values.context)
    throw new Error('Usage: flow:import <flow.js> --context <text> [options], or --preset <name>');
  const constants = Object.fromEntries(
    (values.constant ?? []).map((pair) => {
      const at = pair.indexOf('=');
      if (at < 1) throw new Error(`--constant expects name=value, got ${pair}`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1))
    throw new Error('--threshold must be between 0 and 1');
  return {
    input: positionals[0]!,
    options: {
      context: values.context,
      constants,
      ...(threshold === undefined ? {} : { threshold }),
    },
  };
}

async function run(): Promise<number> {
  if (values.preset && values.preset !== 'creditmantri')
    throw new Error(`Unknown preset ${values.preset}`);
  const { input, options } = values.preset ? CREDITMANTRI_PRESET : fromArguments();
  const map = values.preset ? CREDITMANTRI_PRESET.map : values.map;
  const out = values.preset ? CREDITMANTRI_PRESET.out : values.out;
  const poc = (await import(pathToFileURL(input).href)) as PocFlowModule;
  const { config, notes } = importPocFlow(poc, options);
  for (const note of notes) console.error(`note: ${note}`);
  if (map) {
    const differences = diffConversationMap(config, await readFile(map, 'utf8'), options.constants);
    if (differences.length) {
      console.error(`Conversation map disagrees with ${input}:\n  ${differences.join('\n  ')}`);
      return 1;
    }
  }
  const style = await prettier.resolveConfig(out ?? 'flow.json');
  const json = await prettier.format(JSON.stringify(config), { ...style, parser: 'json' });
  if (!out) process.stdout.write(json);
  else {
    await writeFile(out, json);
    const { nodes, listens, lines } = config.decision.flow;
    console.error(
      `Wrote ${out}: ${nodes.length} nodes, ${listens.length} listen sets, ${Object.keys(lines).length} lines.`,
    );
  }
  return 0;
}

process.exitCode = await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
