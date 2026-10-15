import { rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { pcm16ToMulaw } from '../../../packages/audio/src/g711.ts';
import { MULAW_8K } from '../../../packages/contracts/src/index.ts';
import { LiveKitRoomProvider } from '../../../packages/plugin-room-livekit/src/provider.ts';
import {
  availableLiveKit,
  type TestServer,
} from '../../../packages/plugin-room-livekit/src/testing.ts';

/**
 * Real-browser smoke of the operator desk against a real room server (design 13.4): the browser
 * adapter, a real `livekit-server` (the Apache-2.0 binary, started on loopback by the plugin's own
 * test helper), a real headless caller seat and the real token mint. Only the API is the fixture
 * (`e2e/fixtures/desk-api.mjs`), which hands out the grant this test writes to the file the
 * fixture reads. Skipped unless asked for, since it needs the binary (`brew install livekit`):
 *
 *   OVO_E2E_ROOM_SMOKE=1 OVO_E2E_ROOM_GRANT_FILE=/tmp/ovo-room-grant.json \
 *     pnpm exec playwright test e2e/desk-room.spec.ts --project=desktop-1280
 *
 * The same variable must be in the environment of the Playwright process, so the fixture server
 * it starts sees it. Chromium runs with a fake microphone (a repeating beep). The operator accepts
 * the waiting ticket; the caller seat plays a tone into the room. The test then requires, both
 * ways: the caller seat received the operator's microphone, and the browser's WebRTC statistics
 * show the microphone sent and the caller's tone heard (inbound audio level above zero).
 */
const grantFile = process.env.OVO_E2E_ROOM_GRANT_FILE;
test.skip(
  process.env.OVO_E2E_ROOM_SMOKE !== '1' || !grantFile,
  'set OVO_E2E_ROOM_SMOKE=1 and OVO_E2E_ROOM_GRANT_FILE to run the real room smoke',
);
test.skip(
  ({ viewport }) => (viewport?.width ?? 0) < 1280,
  'one width is enough for the media path',
);

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const frame = (index: number): Uint8Array => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i += 1)
    pcm[i] = Math.round(10_000 * Math.sin((2 * Math.PI * 1800 * (index * 160 + i)) / 8000));
  return pcm16ToMulaw(pcm);
};

test('the operator answers in the browser: the microphone is published and the caller is heard', async ({
  page,
}) => {
  const server: TestServer | undefined = await availableLiveKit();
  if (!server) throw new Error('livekit-server is not installed (brew install livekit)');
  const provider = new LiveKitRoomProvider(server.config());
  const room = 'ovo-hq-smoke';
  const abort = new AbortController();
  let seat: Awaited<ReturnType<typeof provider.join>> | undefined;
  let tone: ReturnType<typeof setInterval> | undefined;
  try {
    await provider.ensureRoom({ name: room, maxParticipants: 3, emptyTimeoutSeconds: 60 });
    seat = await provider.join({
      room,
      identity: 'caller',
      format: MULAW_8K,
      signal: abort.signal,
    });
    let heard = 0;
    seat.onOperatorAudio(() => (heard += 1));
    let index = 0;
    tone = setInterval(() => seat!.sendAudio(frame((index += 1))), 20);

    const { token, expiresAt } = await provider.mintToken({
      room,
      identity: 'op:fixture-admin',
      name: 'Fixture operator',
      role: 'operator',
      ttlSeconds: 120,
    });
    writeFileSync(
      grantFile!,
      JSON.stringify({
        provider: provider.provider,
        serverUrl: server.url,
        roomName: room,
        identity: 'op:fixture-admin',
        role: 'operator',
        token,
        expiresAt,
      }),
    );

    await page
      .context()
      .addCookies([
        { name: 'ovo_session', value: 'admin', domain: '127.0.0.1', path: '/', httpOnly: true },
      ]);
    // Keep every peer connection the page opens, so the test can read the audio statistics.
    await page.addInitScript(() => {
      const connections: RTCPeerConnection[] = [];
      (window as unknown as { __peers: RTCPeerConnection[] }).__peers = connections;
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args);
          connections.push(this);
        }
      };
    });
    await page.goto('/desk');
    await page
      .getByRole('button', { name: /^Accept call/ })
      .first()
      .click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const peers = (window as unknown as { __peers: RTCPeerConnection[] }).__peers;
            let sent = 0;
            let level = 0;
            for (const peer of peers)
              for (const report of (await peer.getStats()).values()) {
                if (report.type === 'outbound-rtp' && report.kind === 'audio')
                  sent += report.bytesSent ?? 0;
                if (report.type === 'inbound-rtp' && report.kind === 'audio')
                  level = Math.max(level, report.audioLevel ?? 0);
              }
            return { sent: sent > 0, heard: level > 0 };
          }),
        { timeout: 20_000, message: 'microphone sent and caller heard' },
      )
      .toEqual({ sent: true, heard: true });
    await expect
      .poll(() => heard, { timeout: 10_000, message: 'caller seat heard the operator' })
      .toBeGreaterThan(0);
  } finally {
    if (tone) clearInterval(tone);
    abort.abort();
    await seat?.close().catch(() => undefined);
    await server.stop();
    rmSync(grantFile!, { force: true });
  }
});
