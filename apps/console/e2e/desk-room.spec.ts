import { expect, test } from '@playwright/test';

/**
 * Real-browser smoke of the operator desk against a real room server (design 13.4). It is skipped
 * unless a stack is running and a harness has opened a ticket and keeps a caller tone playing in
 * its room, which this repository's live-path e2e (tests/e2e/human-room-path) does:
 *
 *   OVO_E2E_ROOM_SMOKE=1
 *   OVO_E2E_DESK_BASE_URL   the console, signed in as an operator who is Available
 *   OVO_E2E_DESK_SESSION    the value of that operator's `ovo_session` cookie
 *
 * Chromium runs with a fake microphone (a repeating beep). The operator accepts the waiting
 * ticket; the test then reads WebRTC statistics and requires that the microphone track was sent
 * and that the caller's tone arrived (inbound audio level above zero).
 */
const enabled = process.env.OVO_E2E_ROOM_SMOKE === '1';
test.skip(!enabled, 'needs a running room server and a ticket: set OVO_E2E_ROOM_SMOKE=1');

test.use({
  baseURL: process.env.OVO_E2E_DESK_BASE_URL,
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test('the operator answers in the browser: the microphone is published and the caller is heard', async ({
  page,
  context,
}) => {
  const url = new URL(process.env.OVO_E2E_DESK_BASE_URL ?? 'http://127.0.0.1:3000');
  await context.addCookies([
    { name: 'ovo_session', value: process.env.OVO_E2E_DESK_SESSION ?? '', domain: url.hostname, path: '/' },
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
  await page.getByRole('button', { name: /^Accept call/ }).first().click();
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
              if (report.type === 'outbound-rtp' && report.kind === 'audio') sent += report.bytesSent ?? 0;
              if (report.type === 'inbound-rtp' && report.kind === 'audio') level = Math.max(level, report.audioLevel ?? 0);
            }
          return { sent: sent > 0, heard: level > 0 };
        }),
      { timeout: 20_000, message: 'microphone sent and caller heard' },
    )
    .toEqual({ sent: true, heard: true });
});
