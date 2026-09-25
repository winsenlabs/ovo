/**
 * `@winsendotai/ovo-conformance`: the conformance kits every plugin kind must pass. Each kit has a
 * vitest `describeX(name, factory, opts)` and a vitest-free `checkX(...)` returning failures.
 * Drivers are re-exported; import `@winsendotai/ovo-conformance/drivers` where vitest must not load.
 */
export * from './describe.ts';
export * from './drivers.ts';
export * from './kit/checks.ts';
export * from './kit/carrier.ts';
export * from './kit/engine.ts';
export * from './kit/inference.ts';
export * from './kit/runner.ts';
export * from './kit/stt.ts';
export * from './kit/tts.ts';
export * from './kit/turn.ts';
export * from './kit/vad.ts';
export * from './reference/fixture-carrier-kit.ts';
