import { Cap, Manifest, type MediaRoomProvider } from '@winsendotai/ovo-contracts';
import { compose, type ParentView } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { httpOrigin, parseRoomConfig, wsOrigin } from '../src/config.ts';
import { roomLivekitPlugin } from '../src/plugin.ts';

const SECRET = 'a-secret-that-is-long-enough-0123456789';
const good = { url: 'ws://127.0.0.1:7880', apiKey: 'k', apiSecret: SECRET };
const parent: ParentView = { keys: new Set(), get: () => undefined, all: () => new Map() };

describe('parseRoomConfig', () => {
  it('defaults the public URL to the internal one', () => {
    expect(parseRoomConfig(good)).toEqual({
      ...good,
      publicUrl: 'ws://127.0.0.1:7880',
      tokenTtlSeconds: 600,
    });
  });

  it('keeps a distinct public URL and a previous key pair', () => {
    expect(
      parseRoomConfig({
        ...good,
        publicUrl: 'wss://rooms.example.net',
        previousApiKey: 'old',
        previousApiSecret: `old-${SECRET}`,
      }),
    ).toMatchObject({
      publicUrl: 'wss://rooms.example.net',
      previousApiKey: 'old',
      previousApiSecret: `old-${SECRET}`,
    });
  });

  it.each([
    ['no url', { ...good, url: undefined }, 'url is required'],
    ['a non-url', { ...good, url: 'not a url' }, 'url is not a URL'],
    ['a file url', { ...good, url: 'file:///x' }, 'url must be ws, wss, http or https'],
    ['credentials in the url', { ...good, url: 'ws://u:p@h:1' }, 'credentials'],
    [
      'a query in the public url',
      { ...good, publicUrl: 'wss://h?token=x' },
      'publicUrl must not carry',
    ],
    ['no key', { ...good, apiKey: '' }, 'apiKey is required'],
    ['a short secret', { ...good, apiSecret: 'short' }, 'apiSecret must be at least 32'],
    ['a previous key without its secret', { ...good, previousApiKey: 'old' }, 'go together'],
    ['a token ttl under the floor', { ...good, tokenTtlSeconds: 10 }, 'tokenTtlSeconds must be'],
    ['a token ttl over the ceiling', { ...good, tokenTtlSeconds: 601 }, 'tokenTtlSeconds must be'],
    ['a fractional token ttl', { ...good, tokenTtlSeconds: 90.5 }, 'tokenTtlSeconds must be'],
    [
      'a short previous secret',
      { ...good, previousApiKey: 'old', previousApiSecret: 'x' },
      'previousApiSecret must be at least 32',
    ],
  ])('refuses %s', (_what, raw, message) => {
    expect(() => parseRoomConfig(raw as Record<string, unknown>)).toThrow(message);
  });

  it('never echoes a secret in its error', () => {
    try {
      parseRoomConfig({ ...good, apiSecret: 'topsecret', url: 'bad' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('topsecret');
    }
  });
});

describe('origins', () => {
  it.each([
    ['ws://h:7880', 'http://h:7880', 'ws://h:7880'],
    ['wss://h', 'https://h', 'wss://h'],
    ['http://h:1/', 'http://h:1', 'ws://h:1'],
    ['https://h/x', 'https://h', 'wss://h'],
  ])('%s is %s over REST and %s over websockets', (url, http, ws) => {
    expect(httpOrigin(url)).toBe(http);
    expect(wsOrigin(url)).toBe(ws);
  });
});

describe('room plugin manifest and composition', () => {
  it('validates and provides ovo.media-room at process scope with no secret fields', () => {
    const manifest = Manifest.parse(roomLivekitPlugin.manifest);
    expect(manifest).toMatchObject({
      kind: 'infra',
      provider: 'livekit',
      scope: 'process',
      provides: [Cap.mediaRoom],
      secretFields: [],
      runtime: { egressHosts: [] },
    });
  });

  it('composes with a valid config and exposes the provider', async () => {
    const graph = await compose(
      [
        {
          id: roomLivekitPlugin.manifest.id,
          config: { ...good, publicUrl: 'wss://rooms.example.net' },
        },
      ],
      [roomLivekitPlugin],
      { scope: 'process', parent },
    );
    try {
      const rooms = graph.get(Cap.mediaRoom) as MediaRoomProvider;
      expect(rooms.provider).toBe('livekit');
      expect(rooms.publicUrl).toBe('wss://rooms.example.net');
    } finally {
      await graph.dispose();
    }
  });

  it('refuses an invalid config at composition, naming the problem', async () => {
    await expect(
      compose(
        [{ id: roomLivekitPlugin.manifest.id, config: { ...good, apiSecret: 'short' } }],
        [roomLivekitPlugin],
        {
          scope: 'process',
          parent,
        },
      ),
    ).rejects.toThrow(/apiSecret/);
  });
});
