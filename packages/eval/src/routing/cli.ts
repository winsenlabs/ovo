// `pnpm eval:routing`: the routing eval harness (docs/eval/routing.md).
//   pnpm eval:routing [run] [--corpus dir] [--label name] [--out dir]
//        [--baseline scorecard.json [--thresholds file]] [--save-baseline file]
//        [--assume-transfer] [--assume-human]
//   pnpm eval:routing diff <baseline.json> <candidate.json> [--thresholds file] [--out dir]
//   pnpm eval:routing snapshot [--corpus dir] [--write]
// Exits 1 when the gate fails against --baseline, 2 on a usage or run error.
import { main } from './commands.ts';

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
