# plugin-room-livekit

`ovo.media-room` over a self-hosted [LiveKit](https://livekit.io) server (Apache-2.0), for R3 human
queues: a ticket bridges the caller into a room, an operator joins from the console. Process scope,
composed only when the room feature is enabled. Host code never names LiveKit; it talks to a
`MediaRoomProvider` and a `RoomSeat` (`packages/contracts/src/human-queue/runtime.ts`).

## Config

`url` (internal signalling, ws/wss/http/https), `publicUrl` (what browsers use; defaults to `url`),
`apiKey` / `apiSecret` (secret of at least 32 characters), and while rotating `previousApiKey` /
`previousApiSecret`. The distribution fills these from `OVO_LIVEKIT_*`; the plugin reads no
environment. Keys never appear in a release, a log or an error. When the server rejects the current
pair the previous one is used (once per call, then remembered), so either side can be rotated first.

## What a caller of the seat can rely on

- `sendAudio(frame)` accepts any chunking of the `format` given to `join`; it re-frames to 20 ms,
  resamples to 16 kHz mono PCM for the room and never blocks. Audio queued toward the room beyond
  300 ms is dropped, and `stats().droppedIn` counts each dropped 20 ms frame (so does a send after
  `close()`).
- `onOperatorAudio` delivers frames of exactly 20 ms in `format` (160 bytes for μ-law 8 kHz), in
  order, only from participants whose identity starts `op:`. A monitor, a guest or the caller's own
  track are never played. Frames that arrive while nobody listens are counted in `droppedOut`. A
  throwing listener is isolated; it never stops the others or the seat.
- `onParticipant` reports `joined` and `left` with `role` `operator | monitor | participant`. A
  listener added late is first told who is already present, in join order. When the room is
  deleted or the connection ends, `left` is reported for everyone.
- `operatorPresent()` is true while an `op:` participant is in the room.
- `sendData` is reliable and ordered, at most 4 KiB (a larger message throws `RangeError`), to
  everyone or to named identities. Operators cannot publish data at all.
- `close()` is idempotent, leaves the room, and freezes `stats().connectedMs`.
- `join` rejects before any network when `format` has no conversion to 16 kHz PCM, when the identity
  could pass as an operator (`op:`, `mon:`, any colon), or when the room does not exist (rooms exist
  only through `ensureRoom`). Aborting the signal at any point closes the seat.

Operator tokens (`mintToken`) name one room, identity `op:<user>` (`mon:<user>` for a monitor),
publish microphone audio only (a monitor publishes nothing), subscribe, no data publish and no
admin, list, create, record or ingress rights, for at most 600 seconds. A room holds three
participants.

## Testing

`@winsendotai/ovo-plugin-room-livekit/testing` starts a loopback-only `livekit-server` on
ephemeral ports (`brew install livekit`, or a binary on `PATH`) or wraps one somebody else runs.
The suites that need a server skip with a reason on stderr when there is none. They cover the
tone round trip told apart with a Goertzel detector, the tokens as the real server enforces them,
key rotation and the media-room conformance kit.

## Native closure

`@livekit/rtc-node` ships a native binding (`@livekit/rtc-ffi-bindings-*` per platform). The
worker image is glibc (`node:24.8.0-bookworm-slim`), where it loads; like the LiveKit engine
plugin this package is not marked `native: glibc`, so a development Mac can run it too.
