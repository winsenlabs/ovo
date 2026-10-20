# Operator desk: running the OVO-managed human queue (Wave 17)

For supervisors and operators. Setup of the room server is in
[livekit-deploy.md](livekit-deploy.md); concepts in [human-queues.md](../architecture/human-queues.md).

## Staff the queue

1. Make sure each operator has a console user (role `viewer` is enough).
2. `PUT /v1/human-queues/operators/<userId>` (admin) with
   `{ "userId": "…", "displayName": "Asha", "enabled": true, "teamIds": ["support"], "languages": ["en","hi"], "capacity": 1 }`.
   A queue with `teamIds` serves operators who share a team; a queue with none serves every enabled
   operator. `languages` matter only to queues whose `language` is `prefer` (order) or `require`
   (eligibility). `capacity` is how many calls one operator may hold at once (`0` takes none).
3. `GET /v1/human-queues/operators` shows profiles with live presence.

## A shift

1. Open **Operator desk**. Chrome and Firefox work; the page must be served over HTTPS (or localhost) for
   the microphone.
2. **Go Available.** The first time you choose a microphone and speaker in the test dialog and hear the
   level meter move. Going Available also unlocks audio playback. Leaving the page, or closing the tab,
   sets you Offline within 30 seconds.
3. A waiting caller appears in the queue with its wait time, language and priority; a chime plays and a
   notification may appear when the tab is hidden. **Accept** (`A`) joins you to the call; **Decline**
   (`D`) passes it on (you will not be offered it again).
4. In the call: the transcript (what was said before the transfer, then live captions), the AI summary
   (labelled as written by the AI that transferred), the call's details. **Mute** (`M`), **Hang up**
   (`H`, with a confirm), **Send back to AI agent** (a menu of the targets this queue allows), and
   **Wrap-up** (a disposition and a note; required before the next call when the queue says so).
5. Away stops new offers but keeps your open call.

## What you see when things go wrong

| Desk says                                           | Meaning and what to do                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "Calls cannot be answered in the browser right now" | the room server is unreachable; tell the person who runs the deployment (`livekit-deploy.md`); do not retry accepting |
| "Another operator took this call"                   | someone accepted first; the list refreshed                                                                            |
| "Reconnecting to the queue"                         | the live feed dropped; it resumes by itself; offers wait                                                              |
| "Connecting caller…" for more than 25 s             | the call is re-offered to someone else; you are released                                                              |
| Microphone blocked                                  | allow it in the browser's site settings, then Go Available again                                                      |
| "Call ended"                                        | the caller hung up or the worker was lost                                                                             |

## Supervisor tasks

- **Queue health.** `GET /v1/human-queues` shows waiting, online operators, handled in 24 h per queue;
  `GET /v1/human-queues/status` shows whether the feature, webhooks and the room server are on and
  reachable.
- **Free a stuck ticket.** `POST /v1/human-queues/tickets/:id/release` (admin) force-releases it; the
  worker ends the segment as `operator_left` and the hold chain continues.
- **After a call.** The call inspector (`/calls/:id`) shows the human segment (queue, wait, talk,
  operator, per-segment cost) and `summary.human`. Caller context is scrubbed
  `OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS` after the call; wrap-up is accepted until then.

## Troubleshooting a call with no sound

1. Is the operator's tab showing **Connected** and the mic level moving? If not, reload the page: a
   reconnect mints a fresh token for the same call.
2. Is the room server reachable from the operator's network? Strict NATs need TURN
   (`OVO_LIVEKIT_TURN_ENABLED`, `livekit-deploy.md`).
3. Is the caller side silent too? Check the worker's `human_failed` / `human_connected` log lines for the
   ticket id, and the room's participants in the server log.
