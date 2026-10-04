export interface SafeReplayBindings {
  readonly transport: {
    readonly kind: 'synthetic';
    dial(): never;
  };
  readonly tools: {
    invoke(input: { toolId: string }): Promise<{
      ok: false;
      code: 'replay_stubbed';
      toolId: string;
    }>;
  };
  readonly mutationPolicy: {
    readonly productionWrites: false;
    readonly liveConnectors: false;
  };
}

/** Replay is fail-closed: no supplied production connector or carrier can be attached. */
export function createSafeReplayBindings(): SafeReplayBindings {
  return Object.freeze({
    transport: Object.freeze({
      kind: 'synthetic' as const,
      dial(): never {
        throw new Error('Replay transport cannot dial');
      },
    }),
    tools: Object.freeze({
      async invoke(input: { toolId: string }) {
        return { ok: false as const, code: 'replay_stubbed' as const, toolId: input.toolId };
      },
    }),
    mutationPolicy: Object.freeze({
      productionWrites: false as const,
      liveConnectors: false as const,
    }),
  });
}

export interface SafeReplayPayload {
  schemaVersion: 1;
  sourceArtifactId: string;
  transport: 'synthetic';
  tools: 'stubbed';
  productionWrites: false;
  liveConnectors: false;
}

export function safeReplayPayload(sourceArtifactId: string): SafeReplayPayload {
  if (!/^[0-9a-f-]{36}$/.test(sourceArtifactId)) throw new Error('Invalid replay artifact ID');
  return {
    schemaVersion: 1,
    sourceArtifactId,
    transport: 'synthetic',
    tools: 'stubbed',
    productionWrites: false,
    liveConnectors: false,
  };
}
