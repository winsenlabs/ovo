import { Cap, type TextFilter } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import { compose, type PluginDefinition, type PluginRegistry } from '@winsendotai/ovo-runtime';

/**
 * Wave 9 D1: the speaker (plugin-voice `speakerTextFilters`) adds the speech normaliser to every
 * agent's text filters, selected or not. The speech cache keys its approvals and per-call clips on
 * exactly the text the speaker sends (TTS-6), so it must add the same filter. Apps may not import
 * plugin-voice: the filter comes from the distribution's registry, as the pre-render takes it
 * (plugin-speech-cache `composeReleaseTextFilters`).
 */
export const SPEECH_NORMALISER_FILTER_ID = '@winsendotai/ovo-text-filter-speech-normaliser';

const log = createLogger({ service: 'worker', component: 'speech-cache' });
/** Stateless filters, composed once per worker process: no call waits on it after the first. */
const composed = new WeakMap<PluginDefinition, Promise<TextFilter[]>>();

/** The filters the speaker adds to the agent's own: the speech normaliser, when installed. */
export function speakerAddedFilters(registry: PluginRegistry): Promise<TextFilter[]> {
  const definition = registry.get(SPEECH_NORMALISER_FILTER_ID);
  if (!definition) return Promise.resolve([]);
  let filters = composed.get(definition);
  if (!filters) {
    filters = compose([{ id: definition.manifest.id, config: {} }], [definition], {
      scope: 'session',
    }).then(
      (composition) => [...composition.all(Cap.textFilters).values()] as TextFilter[],
      (error: unknown) => {
        // swallow-ok: the call goes ahead; lines the normaliser rewrites are synthesised live.
        composed.delete(definition);
        log.warn('speech_normaliser_compose_failed', errorFields(error));
        return [];
      },
    );
    composed.set(definition, filters);
  }
  return filters;
}

/** The speaker's filters: the agent's own, plus each added one it did not select. */
export function withSpeakerFilters(
  own: ReadonlyMap<string, unknown>,
  added: readonly TextFilter[],
): TextFilter[] {
  const filters = [...own.values()] as TextFilter[];
  return [...filters, ...added.filter((filter) => !filters.some((item) => item.id === filter.id))];
}
