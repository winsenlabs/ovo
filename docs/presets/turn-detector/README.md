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

| Rule                                | When                                                                                      | Wait after the caller stops                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `complete`                          | The words so far read complete: a full stop, a short answer, or ≤3 words after a question | `completeSilenceMs` (0), even when `silenceMs` is higher    |
| `silence`                           | No signal either way, a short utterance                                                   | `silenceMs` (50)                                            |
| `long`                              | No signal either way, after 1.2 s of speech (`longUtteranceMs`)                           | `longSilenceMs` (250)                                       |
| `unfinished`                        | Trailing off: "for-", "is a...", "and", "to the", "Paris,", "around the 1", "Rs 500"      | `longSilenceMs`; then the final holds `cutoffHoldMs` (700)  |
| `answer`                            | An answer by itself ("Yes.", "हाँ।", "Hello?"), said with no VAD run open                 | `answerStallMs` (250) after its interim                     |
| `stall`                             | The interim stopped changing while the VAD still heard sound                              | `stallMs` (1500)                                            |
| `noise`                             | The VAD kept hearing sound that brought no words: the room, not the caller                | `noiseMs` (2500) after the last words                       |
| `final`                             | Scribe's final arrived after the VAD went quiet, before the commit                        |                                                             |
| `ceiling`                           | No final within `userSpeechTimeoutMs` (600) of the commit; the turn ends on the interim   |                                                             |
| `hold`                              | Words that trailed off waited `cutoffHoldMs` for more that never came                     | The engine then holds the reply 2 s for the caller to go on |
| `pause`                             | Words that stopped mid-thought or broke off ("any-") waited `pauseHoldMs` (2500)          | None more: the turn waited instead of the reply             |
| `agent`                             | A short reply over the agent's question waited for it to stop (AGT-9)                     |                                                             |
| `vad-timeout`, `provider`, `safety` | The other stop strategies, and the stop safety timer                                      |                                                             |

The energy VAD reports a stop 200 ms (`stopMs`) after the caller goes quiet, and Scribe answers a
commit in about 300–400 ms. So a complete turn ends about 500–650 ms after the caller's last word.

## Commit as the VAD stops (Wave 10)

With `commit.commitAtStop` (on by default) every reading commits as the VAD stops, after
`completeSilenceMs` (0), and Scribe's final decides. A final that reads complete ends the turn at
once, under the rule `complete`, when the words at the stop read complete or gave no signal on a
short utterance. Any other final first waits out the rest of the wait its words had at the stop
(`silenceMs` or `longSilenceMs`), then the hold if it trails off, so a caller who goes on is held
exactly as long as before. That includes a final that reads complete after words that trailed off
or ran long at the stop (`unfinished`, `long`). Scribe closes the segment an early commit cuts with
a full stop ("…to Paris," → "…to Paris."), so its reading is no new signal. And a final that says
more than a stale interim did ("…a lot, so..." → "…so something like that.") reads the same as a
caller who paused after a complete sentence and went on. Call 10d5ef30 turn 13 did that twice. A
final already in hand at the stop waits until the old commit time. A final sooner than 280 ms after
the commit (`MIN_ANSWER_MS`) answered an earlier commit, and ends the turn on arrival as before.
`commitAtStop: false` restores the Wave 8 waits.

The final's words are announced stable (`turn.partial`) as it lands, so the LLM is asked then, even
while the turn waits. That includes a final that says what the last interim said. What the caller
hears comes as much sooner as the commit does: the reply's compose time was 1.1–1.7 s on every
turn of call 4f1a919d without a search, so a wait of 250 ms after the final does not delay it. It
would when nothing is asked ahead, such as while a reply is still being composed.

`packages/plugin-turns/tests/call-endpoints.test.ts` replays every turn of calls 10d5ef30 and
4f1a919d before and after the change. A pause inside a turn has its final moved as much sooner as
its commit:

- **Before:** the replay reproduces every live `endpointMs` within 10 ms.
- **After:** a turn whose words at the stop read complete, or gave no signal on a short utterance,
  ends 50 ms sooner. A turn whose words trailed off or ran long ends when it did, but its LLM is
  asked 250 ms sooner: call 4f1a919d turns 1, 2 and 10, and call 10d5ef30 turns 3, 5, 9, 13, 14 and 17. Every turn has the same words, and no turn ends sooner on words that read unfinished.

The rest of the endpoint has two parts. One is the VAD's 200 ms `stopMs`. The other is Scribe
answering the commit, 286–444 ms on these calls; `stt_commit_answered` logs it per commit.
Scribe's own commit signals do not help. In manual mode it sends none. Its `vad` strategy commits
after `vad_silence_threshold_secs` (1.5 s in the official examples). Its `turn_prediction`
strategy "additionally commits as soon as the model predicts the speaker has finished their turn
(only for models that predict turns)". The reference does not say whether `scribe_v2_realtime`, the
only realtime model, is one of them (unconfirmed, not tried on a live call). Sources: the realtime
API reference and the commit-strategies guide on elevenlabs.io, both retrieved 2026-10-13.

Each wait has a limit:

- **The final decides.** The VAD-stop wait can only judge the interim, and on the live calls the
  interim lagged the audio by 0.7–1 s (it was missing at the stop in 45% of turns). A turn that
  committed early still waits `cutoffHoldMs` when its final trails off. Speech the VAD hears after
  the final is committed again before the turn ends, even before its words show.
- **Words that carry on (Wave 8b, call e8a43f65).** A date range with no month yet for its end
  ("I want 21st of December to the 5th.") is `unfinished` even after a full stop. A turn that ends
  on the `hold` has its reply held by the engine for 2 s (`REPLY_HOLD.trailingMs`, overlapping the
  LLM call), and up to three complete words that carry it on within 5 s ("Of January.": a
  preposition, a conjunction, a month, a lower-case word or the next list item) end like an answer,
  250 ms after their interim instead of the 1.5 s stall. The engine merges them into the held reply.
- **Words that stop mid-thought (Wave 9, call 10d5ef30).** Words that end on a hesitation ("No,
  umm..."), an article or possessive ("…it should still be a") or a preposition or conjunction the
  STT left open ("…what places are nice in-") are the caller thinking, not done. They wait
  `pauseHoldMs` (2500) after the commit instead of `cutoffHoldMs`, timed from the caller's silence
  (a hold that ran out while the VAD still heard them no longer ends the turn), and the turn ends on
  `pause` with no engine hold after it. The LLM is already asked on the final words meanwhile
  (speculation on stable words), so a caller who has stopped hears the reply about as soon as after
  the old 0.7 s hold and 2 s reply hold. Up to three complete words that carry the held words on
  ("built-in.") end like an answer. A capital "A" closing a sentence ("Plan A.") is a name.
  In the call, all three such turns were the caller going on 0.01–1.6 s later; each got a reply
  made for half a sentence, held, and thrown away unheard.
- **Words the STT broke off (Wave 12, call 8cb76efc turns 21 and 24).** A final that ends on a
  dash or an ellipsis ("No. Have there been any-", "…uh, what happens-", "…so...") waits
  `pauseHoldMs` like words that stop mid-thought, not `cutoffHoldMs`. Live the 700 ms hold ended
  both turns 0.8 s and 0.4 s before the caller went on; the LLM wrote "Could you finish your
  question?" and "Sorry, could you say that again?" for them, which only the engine's 2 s reply
  hold kept from playing. A caller who has stopped hears the reply 2.5 s after the final, against
  0.7 s plus that 2 s before.
- **Words that add nothing to a reply on its way (Wave 12, call 8cb76efc turn 20).** Once the
  caller's turn has ended and its filler or search line has started, but no line of the reply
  itself, words begun while that line plays or within 1 s (`FILLER_TAIL_MS`) of its end that only
  add a "please" or a yes ("Please.", "Okay.", "Yes, please.") or are outside the agent's languages
  end on `turn.reset` (`backchannel`), not as a turn: the reply answers them. Live "Please." was
  queued behind the search and answered after the reply, 11.8 s later, after the agent had asked
  "Want to hear more?" and been given no answer. A question ("Okay?", "Hello?"), a greeting, thanks,
  a no, a goodbye or any words that change the request are still a turn, and so is anything begun
  later: a filler with no reply after it must not swallow the caller asking where it went, nor
  anything said 8 s or more after the turn ended.
- **Words muted over the agent (Wave 12, call 8cb76efc turn 6).** Words the STT gives while speech
  is muted (a disclosure, the opening, a tool running) are dropped; the detector now also commits a
  manual-commit STT (Scribe) when that speech ends (its VAD stop, or the agent stopping with no VAD
  speech going on) and drops whatever the STT still says in those segments. Live nothing committed
  them, and the caller's first turn began with the Hindi said over the opening 7 s earlier.
- **A request begun as the reply starts (Wave 9, call 10d5ef30 turn 11).** Words over the agent
  with no VAD speech behind them are the room, unless they began no later than
  `speechEvidence.replyStartMs` (1000) after the reply started to play and ask for something
  ("Tell me the name.", its first interim 87 ms into the answer): the caller began them before
  hearing it. They wait for the agent to stop and end on `agent`. Words that ask nothing stay the
  room's, however early. A dropped turn's words now ride on `turn.reset` (`text`).
- **No filler before a goodbye (Wave 9).** A turn that says goodbye or closes the conversation
  ("Never mind. Thank you.") is offered no filler line: its reply is a goodbye ("One moment." played
  180 ms before "Shall I end the call?" on turn 22).
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
