import type { FixtureTemplate } from '@winsendotai/ovo-contracts';

/** A call ends on caller hangup; keep the vendor's opening/transcript script, omit its graceful finish. */
export function callerHangupTemplate(
  source: FixtureTemplate,
  terminalType: string,
): FixtureTemplate {
  return (input) =>
    source(input).map((script) => {
      const at = script.steps.findIndex(
        (step) =>
          'expect' in step &&
          step.expect === 'ws-send' &&
          (step.where?.type === terminalType || step.where?.event === terminalType),
      );
      if (at < 0) throw new Error(`Vendor fixture has no ${terminalType} finish step`);
      return { ...script, steps: script.steps.slice(0, at) };
    });
}
