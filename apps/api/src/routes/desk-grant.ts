import { humanRoomName, type MediaRoomProvider, type RoomGrant } from '@winsendotai/ovo-contracts';

/** A room has the caller's seat, the operator and (later) a supervisor. */
export const ROOM_MAX_PARTICIPANTS = 3;
/** An unjoined room is removed by the server after this long; the reaper covers the rest. */
export const ROOM_EMPTY_SECONDS = 120;

export const operatorIdentity = (userId: string) => `op:${userId}`;

/**
 * The operator's join grant for a ticket's room: identity `op:<userId>`, audio only, valid for
 * `ttlSeconds` and for this room alone. The room's API secret never leaves the room provider.
 */
export async function mintOperatorGrant(
  rooms: MediaRoomProvider,
  input: {
    ticketId: string;
    roomName?: string;
    userId: string;
    displayName: string;
    ttlSeconds: number;
  },
): Promise<RoomGrant> {
  const roomName = input.roomName ?? humanRoomName(input.ticketId);
  const identity = operatorIdentity(input.userId);
  const { token, expiresAt } = await rooms.mintToken({
    room: roomName,
    identity,
    name: input.displayName || input.userId,
    role: 'operator',
    ttlSeconds: input.ttlSeconds,
  });
  return {
    provider: rooms.provider,
    serverUrl: rooms.publicUrl,
    roomName,
    identity,
    role: 'operator',
    token,
    expiresAt,
  };
}
