import { flowLineTemplates } from '@winsendotai/ovo-contracts';
import { templateSchema, validateTemplatePaths } from '@winsendotai/ovo-behaviors';
import type { CompatRule } from './types.ts';
import { issue } from './types.ts';

/**
 * A flow line may only read variables the agent declares, or a built-in date, exactly like every
 * other spoken agent line (`template-variable-undeclared.ts`). A line naming anything else would be
 * skipped on every call, so it blocks the release.
 */
export const flowVariables: CompatRule = (input, stage) => {
  const flow = input.config.decision?.flow;
  if (!flow || input.config.mode !== 'agent') return [];
  const schema = templateSchema(input.config);
  return flowLineTemplates(flow).flatMap((line) => {
    try {
      validateTemplatePaths(line.template, schema);
      return [];
    } catch (error) {
      const field = `decision.flow.${line.field}`;
      return [
        issue(
          'template_variable_undeclared',
          stage,
          `${field}: ${error instanceof Error ? error.message : String(error)}`,
          { field },
        ),
      ];
    }
  });
};
