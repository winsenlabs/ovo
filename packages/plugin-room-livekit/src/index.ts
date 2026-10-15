import type { PluginDefinition } from '@winsendotai/ovo-runtime';

/**
 * Room plugin for the self-hosted LiveKit server (Apache-2.0): the only implementation of the
 * `ovo.media-room` capability (`MediaRoomProvider`, `RoomSeat`). Composed only when
 * `OVO_LIVEKIT_ENABLED=true`. The media lane implements the provider; until it lands this package
 * carries the pinned dependencies and the conformance test that every implementation must pass.
 */
export const ROOM_PLUGIN_ID = '@winsendotai/ovo-plugin-room-livekit';

/** The plugins this package provides; the media lane registers the room provider here. */
export const plugins: PluginDefinition[] = [];
