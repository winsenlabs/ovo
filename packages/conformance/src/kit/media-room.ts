import { AUDIO_CHECKS } from './media-room-audio.ts';
import type { MediaRoomKitContext } from './media-room-fixture.ts';
import { PRESENCE_CHECKS } from './media-room-presence.ts';
import { TOKEN_CHECKS } from './media-room-tokens.ts';
import type { KitCheck } from './runner.ts';

export type { MediaRoomKitContext, MediaRoomKitOptions } from './media-room-fixture.ts';

/** The `ovo.media-room` contract every room implementation passes: lifecycle, tokens, presence, audio, data. */
export const MEDIA_ROOM_CHECKS: readonly KitCheck<MediaRoomKitContext>[] = [
  ...TOKEN_CHECKS,
  ...PRESENCE_CHECKS,
  ...AUDIO_CHECKS,
];
