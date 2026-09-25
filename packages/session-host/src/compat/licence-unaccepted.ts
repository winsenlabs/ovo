import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const licenceUnaccepted: CompatRule = (input, stage) =>
  resolved(input).flatMap(({ slot, choice, definition }) =>
    (manifestKeys(definition.manifest).manifest.runtime?.modelLicences ?? []).flatMap((licence) =>
      input.acceptedLicences?.includes(licence) ||
      input.config.voice?.acknowledgements.includes(`model-licence:${licence}` as never)
        ? []
        : [
            issue('licence_unaccepted', stage, `Model licence ${licence} was not acknowledged`, {
              slot: slot as never,
              pluginId: choice.pluginId,
            }),
          ],
    ),
  );
