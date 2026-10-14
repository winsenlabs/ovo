// `pnpm eval:calls`: the call-eval harness (docs/eval/README.md).
//   pnpm eval:calls [run] [--mode transcript|live|audio] [--corpus dir] [--calls a,b] [--label name]
//        [--detector rules|module:<path>[#export]] [--detector-config json|@file] [--vad trace|audio]
//        [--stt id --keys file [--llm-model id]] [--transcripts dir] [--out dir]
//        [--baseline scorecard.json [--thresholds file]] [--save-baseline file]
//   pnpm eval:calls diff <baseline.json> <candidate.json> [--thresholds file] [--out dir]
//   pnpm eval:calls slim --from <raw corpus> --to <dir> [--calls a,b]
//   pnpm eval:calls stt-configs [--keys file]
// Exits 1 when the gate fails against --baseline, 2 on a usage or run error.
// The engine logs a JSON line per reply hold and STT commit, which would bury the report: errors
// only unless OVO_LOG_LEVEL says otherwise. Set before the engine's modules load.
process.env.OVO_LOG_LEVEL ??= 'error';
export {};
const { main } = await import('./commands.ts');

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
