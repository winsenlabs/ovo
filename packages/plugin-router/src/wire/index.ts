/*
 * The simulation and eval wire shapes. Wave 18's core lane lands the same definitions in
 * `@winsendotai/ovo-contracts` (routing/simulate.ts, simulate-result.ts, eval.ts, scorecard.ts);
 * once they are there this file becomes `export { ... } from '@winsendotai/ovo-contracts'` and the
 * sibling modules are deleted. Nothing else in the plugin imports them directly.
 */
export * from './simulate.ts';
export * from './result.ts';
export * from './eval.ts';
