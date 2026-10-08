# Turn detector presets for phone calls

The default turn detector (`@winsendotai/ovo-turn-detector-default`) decides when the caller has
finished speaking. On phone calls with a manual-commit STT (ElevenLabs Scribe) and the energy VAD
it runs the `commit` strategy: once the caller goes quiet it forces Scribe to finalise, and the
turn ends on Scribe's final. `phone.json` is the recommended row; it equals the detector's defaults
(`PHONE_TURN_CONFIG`; `phone-turns.test.ts` keeps the two equal), so an agent needs no `commit`
block at all.

## Recommended row (Wave 8)

```json
{ "turnDetector": { "plugin": "@winsendotai/ovo-turn-detector-default", "config": {} } }
```

Keep the agent's own `minWordsWhileBotSpeaking`, `backchannels` and `filler`. Remove
`commit.silenceMs` from rows that set it to 450 (Maya, CreditMantri). The default of **50** is the
recommended value. 450 was the Wave 6 fix for turns that ended mid-sentence (call B, 15 of 67
finals ended in "-"). The detector now holds those itself, from Scribe's final ("for-", "and",
"around the 1"), so 450 only adds about 400 ms to every short turn.

## How a turn ends

Every speech turn's `turn.stopped` carries the rule that ended it (`reason`, an `EndpointRule`).
Wave 8 adds it so endpoint latency can be attributed per turn.

| Rule                                | When                                                                                      | Wait after the caller stops                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `complete`                          | The words so far read complete: a full stop, a short answer, or ≤3 words after a question | `completeSilenceMs` (50), even when `silenceMs` is higher  |
| `silence`                           | No signal either way, a short utterance                                                   | `silenceMs` (50)                                           |
| `long`                              | No signal either way, after 1.2 s of speech (`longUtteranceMs`)                           | `longSilenceMs` (250)                                      |
| `unfinished`                        | Trailing off: "for-", "is a...", "and", "to the", "Paris,", "around the 1", "Rs 500"      | `longSilenceMs`; then the final holds `cutoffHoldMs` (700) |
| `answer`                            | An answer by itself ("Yes.", "हाँ।", "Hello?"), said with no VAD run open                 | `answerStallMs` (250) after its interim                    |
| `stall`                             | The interim stopped changing while the VAD still heard sound                              | `stallMs` (1500)                                           |
| `noise`                             | The VAD kept hearing sound that brought no words: the room, not the caller                | `noiseMs` (2500) after the last words                      |
| `final`                             | Scribe's final arrived after the VAD went quiet, before the commit                        |                                                            |
| `ceiling`                           | No final within `userSpeechTimeoutMs` (600) of the commit; the turn ends on the interim   |                                                            |
| `hold`                              | Words that trailed off waited `cutoffHoldMs` for more that never came                     |                                                            |
| `agent`                             | A short reply over the agent's question waited for it to stop (AGT-9)                     |                                                            |
| `vad-timeout`, `provider`, `safety` | The other stop strategies, and the stop safety timer                                      |                                                            |

The energy VAD reports a stop 200 ms (`stopMs`) after the caller goes quiet, and Scribe answers a
commit in about 300–400 ms. So a complete turn ends about 600 ms after the caller's last word.

Each wait has a limit:

- **The final decides.** The VAD-stop wait can only judge the interim, and on the live calls the
  interim lagged the audio by 0.7–1 s (it was missing at the stop in 45% of turns). A turn that
  committed early still waits `cutoffHoldMs` when its final trails off. Speech the VAD hears after
  the final is committed again before the turn ends, even before its words show.
- **One-word answers.** A short "yes" is often too short or soft to start the energy VAD. A
  -30 dBFS word never does. With no VAD stop, the turn used to wait for the 1.5 s stall. Now an
  answer that ends a turn by itself ("Yes.", "हाँ।", "Hello?", "No", "15", a backchannel) commits
  250 ms after its interim. Any other words keep the 1.5 s stall, however short ("My name is",
  "Two adults" may go on), and so does anything said while a VAD run is open, even one the room
  holds: Scribe's interims change only about once a second and the caller may be going on.
- **Noise.** Café babble near the phone is modulated like speech. It can hold the energy VAD on
  for as long as it lasts, and it can restart the VAD right after a commit. A VAD run that brings
  no new words for `noiseMs` no longer holds a turn with words open. The energy VAD also recovers
  by itself: its `roomRecoveryMs` (1500) ends an utterance once its sound has stayed within 4 dB
  of the room's level between utterances for that long, after a caller at least 8 dB above the
  room. A cough or a loud first word does not move that reference, so speech softer than it is
  never taken for the room.
- **Replies said long before a question.** Over the agent, a reply shorter than
  `minWordsWhileBotSpeaking` answers the agent's question when the agent stops. That holds only if
  the reply came within `questionReplyMs` (6000) of the agent stopping. Said earlier, it came
  before the question was heard, and it only acknowledged what the agent was saying then.

## Measured on the live calls

`packages/plugin-turns/tests/endpoint-replay.test.ts` and `noise-endpoint.test.ts` replay the turns
of Maya calls 6e1a4e3a (2026-10-08, a café) and f3363705 (2026-10-07). Each replay uses the turn's
own Scribe latency. With the Wave 8 rules turned off, every replay reproduces the live
`endpointMs` to within 1 ms.

| Turns                                                                 | Live (ms) | Now (ms)                 | Saved                 |
| --------------------------------------------------------------------- | --------- | ------------------------ | --------------------- |
| Short complete turns, recommended row (turns 2, 7, 16)                | 985–1020  | 585–620                  | 400 ms                |
| Long turns, recommended row (turns 4, 15)                             | 1006–1009 | 806–809                  | 200 ms                |
| Complete interim at the VAD stop, Maya's 450 ms kept                  | ~1013     | 613                      | 400 ms                |
| One-word answers the VAD never timed (6e1a4e3a 3/21/22, f3363705 6/8) | 1799–1892 | 549–642                  | 1250 ms               |
| "Yes." with a VAD run under `minSpeechMs`                             | ~2630     | 1130                     | 1500 ms               |
| "Yeah." said into a VAD the room holds open                           | 1873      | 1873                     | none (kept: no split) |
| Turn 9, "Hardik?" 9.4 s before the end of a 12 s answer               | 9426      | dropped as a backchannel | no 9.4 s turn         |
| Turn 17 + 18, "…around the 1" + "st."                                 | two turns | one turn, 965 ms         | one fewer search turn |
| Café noise restarting the VAD after the commit                        | 11 100    | 4 150 after the words    | 6950 ms               |

Only the first row needs the config change: Maya and CreditMantri keep paying about 400 ms a turn
until `commit.silenceMs` 450 is removed.
