import { Cap, type TextFilter } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  INDIAN_VERBALISATION_FILTER_ID,
  indianVerbalisationFilter,
} from './indian-verbalisation.ts';

export {
  INDIAN_VERBALISATION_FILTER_ID,
  indianNumberWords,
  indianVerbalisationFilter,
} from './indian-verbalisation.ts';

export const MARKDOWN_FILTER_ID = '@winsendotai/ovo-text-filter-markdown';
export const URL_FILTER_ID = '@winsendotai/ovo-text-filter-url';

/** Strip formatting tokens but retain the words the caller should hear. */
export const markdownFilter: TextFilter = {
  id: MARKDOWN_FILTER_ID,
  order: 10,
  apply(text) {
    return text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/(?:^|\n)\s{0,3}#{1,6}\s+/g, ' ')
      .replace(/(?:^|\n)\s*[-*+]\s+/g, ' ')
      .replace(/(^|\s)(\*{1,2}|~{2})(?=\S)(.+?)(?<!\s)\2(?=$|[\s.,!?;:])/g, '$1$3')
      .replace(/`([^`]+)`/g, '$1')
      .split(/(https?:\/\/[^\s]+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,})/gi)
      .map((part, index) =>
        index % 2
          ? part
          : part
              .replace(/(^|\s)(_{1,2})(?=\S)(.+?)(?<!\s)\2(?=$|[\s.,!?;:])/g, '$1$3')
              .replace(/[*`~]+/g, ''),
      )
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  },
};

/** Speak punctuation in addresses instead of reading it as a path or a word. */
export const urlFilter: TextFilter = {
  id: URL_FILTER_ID,
  order: 20,
  apply(text) {
    return text
      .replace(/https?:\/\/[^\s]+/gi, (url) =>
        url
          .replace(/^https?:\/\//i, '')
          .replace(/\./g, ' dot ')
          .replace(/\//g, ' slash ')
          .replace(/:/g, ' colon '),
      )
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, (email) =>
        email.replace('@', ' at ').replace(/\./g, ' dot '),
      )
      .replace(/\s+/g, ' ')
      .trim();
  },
};

/** The one order every speaker applies filters in: lowest `order` first, then by id. */
export function orderTextFilters(filters: readonly TextFilter[]): TextFilter[] {
  return [...filters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The text a speaker sends to TTS. Speech cache keys and pre-rendered inventories are computed on
 * this output, never on the raw configured string, or a pre-rendered clip would silently never match.
 */
export function filterSpeechText(
  filters: readonly TextFilter[],
  text: string,
  language: string,
): string {
  for (const filter of orderTextFilters(filters)) text = filter.apply(text, { language });
  return text;
}

function defineFilter(id: string, filter: TextFilter) {
  return definePlugin(
    {
      id,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'text-filter',
      provider: 'ovo',
      requires: [],
      provides: [Cap.textFilters],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.textFilters, filter);
    },
  );
}

export function createMarkdownTextFilterPlugin() {
  return defineFilter(MARKDOWN_FILTER_ID, markdownFilter);
}

export function createUrlTextFilterPlugin() {
  return defineFilter(URL_FILTER_ID, urlFilter);
}

export function createIndianVerbalisationTextFilterPlugin() {
  return defineFilter(INDIAN_VERBALISATION_FILTER_ID, indianVerbalisationFilter);
}
