import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type { StreamingStt, StreamingSttSession } from '@winsendotai/ovo-plugin-voice';
import WebSocket from 'ws';
import { abortError, withDeadline } from './abort.ts';
import { createDeepgramSession } from './deepgram-session.ts';
import {
  openDeepgramSocket,
  validateDeepgramEndpoint,
  waitForReconnect,
  type DeepgramWebSocketFactory,
} from './deepgram-transport.ts';
import { immutableBinding, type DeepgramBinding, type ProviderUsageSink } from './types.ts';

const DEEPGRAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
type StreamingSttRequest = Parameters<StreamingStt['start']>[0];

export type { DeepgramWebSocketFactory } from './deepgram-transport.ts';

export interface DeepgramDependencies {
  secrets: SecretResolver;
  usage?: ProviderUsageSink;
  webSocketFactory?: DeepgramWebSocketFactory;
  /** Not plugin-configurable. Used by local WSS protocol tests only. */
  endpoint?: string;
  allowPrivateTestEndpoint?: boolean;
}

export class DeepgramStreamingStt implements StreamingStt {
  readonly binding: Readonly<DeepgramBinding>;
  private readonly endpoint: URL;
  private readonly socketFactory: DeepgramWebSocketFactory;

  private constructor(
    binding: DeepgramBinding,
    private readonly apiKey: string,
    private readonly usageSink: ProviderUsageSink | undefined,
    dependencies: DeepgramDependencies,
  ) {
    this.binding = immutableBinding(binding);
    validateBinding(this.binding);
    this.endpoint = validateDeepgramEndpoint(
      dependencies.endpoint ?? DEEPGRAM_ENDPOINT,
      dependencies.allowPrivateTestEndpoint,
    );
    this.socketFactory =
      dependencies.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  }

  static async create(
    binding: DeepgramBinding,
    dependencies: DeepgramDependencies,
  ): Promise<DeepgramStreamingStt> {
    const snapshot = immutableBinding(binding);
    const apiKey = await dependencies.secrets.resolve(snapshot.workspaceId, snapshot.credentialId);
    return new DeepgramStreamingStt(snapshot, apiKey, dependencies.usage, dependencies);
  }

  async start(request: StreamingSttRequest): Promise<StreamingSttSession> {
    if (request.codec !== 'audio/x-mulaw' || request.sampleRate !== 8_000)
      throw new TypeError('Deepgram Twilio profile requires 8 kHz G.711 mu-law input');
    if (this.binding.language && request.language !== this.binding.language)
      throw new TypeError('STT request language does not match the immutable provider binding');
    const lifetime = withDeadline(
      request.signal,
      this.binding.maxSessionMs,
      'Deepgram session deadline exceeded',
    );
    try {
      const socket = await this.connectWithRetry(lifetime.signal, request.language);
      return createDeepgramSession(socket, request, this.binding, lifetime, this.usageSink);
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
  }

  private async connectWithRetry(signal: AbortSignal, language: string): Promise<WebSocket> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.binding.connectAttempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      try {
        return await openDeepgramSocket(
          this.socketFactory,
          this.listenUrl(language),
          {
            headers: { authorization: `Token ${this.apiKey}` },
            maxPayload: this.binding.maxMessageBytes,
          },
          signal,
          this.binding.connectTimeoutMs,
        );
      } catch (error) {
        lastError = error;
        if (attempt === this.binding.connectAttempts || signal.aborted) throw error;
        // Retries happen only before start() returns, so no caller audio exists to duplicate.
        await waitForReconnect(Math.min(1_000, 100 * 2 ** (attempt - 1)), signal);
      }
    }
    throw lastError;
  }

  private listenUrl(language: string): string {
    const url = new URL(this.endpoint);
    const parameters: Record<string, string> = {
      model: this.binding.model,
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      interim_results: 'true',
      vad_events: 'true',
      endpointing: String(this.binding.endpointingMs),
    };
    parameters.language = this.binding.language ?? language;
    if (this.binding.utteranceEndMs !== undefined)
      parameters.utterance_end_ms = String(this.binding.utteranceEndMs);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url.href;
  }
}

function validateBinding(binding: Readonly<DeepgramBinding>): void {
  for (const field of [
    'endpointingMs',
    'connectAttempts',
    'connectTimeoutMs',
    'finishTimeoutMs',
    'maxSessionMs',
    'keepAliveMs',
    'maxInputChunkBytes',
    'maxBufferedBytes',
    'maxMessageBytes',
  ] as const)
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1)
      throw new TypeError(`${field} must be a positive integer`);
  if (
    binding.utteranceEndMs !== undefined &&
    (!Number.isSafeInteger(binding.utteranceEndMs) || binding.utteranceEndMs < 1)
  )
    throw new TypeError('utteranceEndMs must be a positive integer');
}
