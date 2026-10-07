import type { OpenAIProvider } from '@ai-sdk/openai';
import type { Tool } from 'ai';
import { dropSpokenCitations, type MeterDeclaration } from '@winsendotai/ovo-contracts';
import type { ProviderToolResult } from '@winsendotai/ovo-plugin-kit';
import { SEARCH_ANNOUNCE_SCHEMA, type SearchAnnounceConfig } from './search-voice.ts';

export const SEARCH_CONTEXT_SIZES = ['low', 'medium', 'high'] as const;
export type SearchContextSize = (typeof SEARCH_CONTEXT_SIZES)[number];

/**
 * OpenAI's built-in web search (Responses API `web_search` tool). Off unless `enabled`. The default
 * context size is `low`, the fastest and cheapest, because a voice caller is waiting on it.
 */
export interface WebSearchConfig {
  enabled: boolean;
  searchContextSize?: SearchContextSize;
  /** Approximate caller location, so "near me" and local questions get local results. */
  userLocation?: {
    /** ISO 3166-1 alpha-2, e.g. `IN`. */
    country?: string;
    city?: string;
    region?: string;
    /** IANA, e.g. `Asia/Kolkata`. */
    timezone?: string;
  };
  /** Only search these domains (and their subdomains); no scheme. At most 100. */
  allowedDomains?: string[];
  /**
   * N3: the lines a voice engine says while a search runs (`DEFAULT_SEARCH_ANNOUNCEMENT` field by
   * field), or `false` for none.
   */
  announce?: SearchAnnounceConfig;
  /** N3: leave the search tool out for a cut-off or backchannel-only caller turn. Default true. */
  skipUnclearInput?: boolean;
}

/** The tool name the model sees; OVO tool ids must not use it while web search is enabled. */
export const WEB_SEARCH_TOOL = 'web_search';

/** `meters` entry for the per-call web search charge; required only of bindings that enable it. */
export const WEB_SEARCH_METER: MeterDeclaration = {
  key: 'openai.inference.web_search_calls',
  unit: 'web_search_calls',
  label: 'OpenAI web search tool calls',
  role: 'llm',
  when: { field: 'webSearch.enabled', in: ['true'] },
};

/** The binding schema's `webSearch` property (strict, like the rest of the binding). */
export const WEB_SEARCH_BINDING_SCHEMA = {
  type: 'object',
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    searchContextSize: { enum: [...SEARCH_CONTEXT_SIZES] },
    userLocation: {
      type: 'object',
      properties: {
        country: { type: 'string', pattern: '^[A-Z]{2}$' },
        city: { type: 'string', minLength: 1, maxLength: 100 },
        region: { type: 'string', minLength: 1, maxLength: 100 },
        timezone: { type: 'string', pattern: '^[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)*$', maxLength: 64 },
      },
      additionalProperties: false,
    },
    allowedDomains: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', pattern: '^(?!https?://)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' },
    },
    announce: SEARCH_ANNOUNCE_SCHEMA,
    skipUnclearInput: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

/** The provider tools a binding sends: OpenAI's web search when enabled, otherwise none. */
export function webSearchTools(
  provider: Pick<OpenAIProvider, 'tools'>,
  config: WebSearchConfig | undefined,
): Record<string, Tool> | undefined {
  if (!config?.enabled) return undefined;
  const { userLocation, allowedDomains } = config;
  return {
    [WEB_SEARCH_TOOL]: provider.tools.webSearch({
      searchContextSize: config.searchContextSize ?? 'low',
      ...(userLocation ? { userLocation: { type: 'approximate', ...userLocation } } : {}),
      ...(allowedDomains?.length ? { filters: { allowedDomains } } : {}),
    }) as Tool,
  };
}

/**
 * Web search calls the step ran that OpenAI bills: "Search actions incur a tool call cost"
 * (https://developers.openai.com/api/docs/guides/tools-web-search, retrieved 2026-10-07). A
 * call's `openPage`/`findInPage` actions are not searches; a call with no action reported is
 * counted, so an unknown never goes unbilled.
 */
export function webSearchUsage(results: readonly ProviderToolResult[]) {
  const calls = results.filter((result) => {
    if (result.toolName !== WEB_SEARCH_TOOL) return false;
    const action = (result.output as { action?: { type?: unknown } } | undefined)?.action;
    return action?.type === undefined || action.type === 'search';
  }).length;
  return calls ? [{ unit: 'web_search_calls' as const, quantity: calls }] : [];
}

/**
 * Removes what a web search answer carries for a screen and not for a caller's ear: inline
 * citations (`([site](url))`, `【4†source】`, `[1]`), markdown links (kept as their text) and bare
 * URLs (kept as their host). Applied before text reaches the segmenter and the TTS filter chain.
 */
export function stripCitations(text: string): string {
  return dropSpokenCitations(text)
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/g, '$1');
}

/** Characters that may open a citation the next delta closes. */
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '【': '】' };
/** A held span longer than this is released as is, so a stray bracket cannot mute a reply. */
const MAX_HELD = 600;

/**
 * Streams `stripCitations` over provider deltas. A citation or URL can arrive split across deltas,
 * so text from an unclosed bracket, or a trailing URL-like word, is held until it can be judged.
 */
export class StreamingCitationStripper {
  private held = '';

  push(delta: string): string {
    this.held += delta;
    const cut = this.safeLength(this.held);
    const ready = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return ready ? stripCitations(ready) : '';
  }

  finish(): string {
    const rest = this.held;
    this.held = '';
    return rest ? stripCitations(rest) : '';
  }

  /** The longest prefix no later delta can turn into (part of) a citation. */
  private safeLength(text: string): number {
    if (text.length > MAX_HELD) return text.length;
    const open: { close: string; at: number }[] = [];
    let lastLink: { at: number; end: number } | undefined;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      const close = OPENERS[char];
      if (close) open.push({ close, at: index });
      else if (open.length && open[open.length - 1]!.close === char) {
        const group = open.pop()!;
        if (char === ']') lastLink = { at: group.at, end: index };
      }
    }
    let cut = open.length ? open[0]!.at : text.length;
    // A closed `[text]` at the end may be a link whose `(url)` is still to come.
    if (!open.length && lastLink && !text.slice(lastLink.end + 1).trim()) cut = lastLink.at;
    // A trailing word that is, or may become, a URL.
    const word = /\S*$/.exec(text.slice(0, cut))!;
    if (/^\(?(?:https?:\/\/\S*|h|ht|htt|https?|https?:|https?:\/)$/i.test(word[0]))
      cut = word.index;
    // Hold the space before whatever is held, so a removed citation leaves no stray space.
    while (cut > 0 && /[ \t]/.test(text[cut - 1]!)) cut--;
    return cut;
  }
}
