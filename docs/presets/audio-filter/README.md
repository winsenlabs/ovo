# Audio filter presets for phone calls

The telephony audio filter (`@winsendotai/ovo-audio-filter-telephony`) cleans the caller's audio
before the VAD and the STT hear it. It has three parts: a 100 Hz high-pass for handling rumble,
notches on 50 Hz mains hum and its harmonics, and an optional noise gate.

Since Wave 8 it is **on by default**. The distribution preselects it for every agent that selects
no filter (`DISTRIBUTION_DEFAULTS.audioFilter`). With its default `engage: 'detect'`, the
high-pass and the notches stay out until the line shows the fault each one fixes:

- **Hum:** the mains harmonics stand 10 dB above the bins between them for a whole second.
- **Rumble:** a quarter of a quarter-second's power sits below 80 Hz.

Until then the audio passes through sample for sample. A stage that engages stays on for the
rest of the call and fades in over 20 ms, so the switch makes no click.

The VAD's own 200 Hz high-pass and its tone and vibration rejection run on every call either way.

## Choosing a row for one agent

An agent's own `voice.audioFilter` replaces the default. Paste a preset file as the value:

| Preset                 | When                                                                 | Row                                                                 |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `telephony.json`       | The default: 8 kHz calls from India                                  | high-pass 100 Hz, 50 Hz hum ×4 harmonics, `engage: detect`, no gate |
| `telephony-noisy.json` | Callers in steady noise (fans, traffic), after comparing transcripts | the same, plus a downward expander (10 dB / 12 dB)                  |

- **Mains at 60 Hz** (the Americas): set `hum.mainsHz` to 60.
- **Every stage from the first frame** (the Wave 7 behaviour): set `engage: 'always'`. It costs
  words in a cafe, as the table below shows.
- **Delay:** the filter adds under 1 ms and buffers nothing, so turn-taking latency does not
  change.

## What it does to transcripts

`packages/plugin-audio-filter/tests/transcript-quality.test.ts` compares transcripts with the
filter off, with each preset, and with the phone preset always on.

- **Speech:** real 8 kHz mu-law. There are eight agent lines from the live CreditMantri release's
  pre-rendered clips. No caller audio exists to use, because live calls were not recorded.
- **Noise:** added on top, seeded and repeatable (`tests/fixtures/phone-noise.ts`). Wave 8 added
  three conditions from call 6e1a4e3a, made from a noisy cafe:
  - **cafe:** six voices a little way off, cups and cutlery, and espresso steam;
  - **babble:** eight voices, none intelligible;
  - **street:** passing traffic, an engine drone and a horn.
- **Takes:** each noisy condition is mixed three times with different noise, so a noisy
  condition has 363 reference words and the clean line has 121.
- **ASR:** an offline Indian-English model (Vosk, `vosk-model-small-en-in-0.4`), not Scribe, so
  no provider key is used in tests.
- **Word error rate:** measured against the same ASR's transcript of the clean clip, so it
  measures only what the noise and the filter change.

Measured 2026-10-08:

| Condition (speech-to-noise)         | Off   | `telephony` (detect) | `telephony-noisy` | Always on (Wave 7) |
| ----------------------------------- | ----- | -------------------- | ----------------- | ------------------ |
| Clean line                          | 0.0%  | 0.0%                 | 0.0%              | 0.0%               |
| Handling rumble and thumps (-5 dB)  | 28.1% | 27.8%                | 27.8%             | 28.9%              |
| 50 Hz mains hum (0 dB)              | 9.1%  | 1.7%                 | 1.7%              | 0.8%               |
| Phone vibrating, 175 Hz (5 dB)      | 6.6%  | 6.6%                 | 6.6%              | 9.1%               |
| Steady fan or traffic noise (10 dB) | 9.6%  | 9.6%                 | 9.6%              | 8.8%               |
| Three background talkers (10 dB)    | 25.9% | 25.9%                | 25.9%             | 25.9%              |
| 1 kHz beeps (5 dB)                  | 0.0%  | 0.0%                 | 0.0%              | 0.0%               |
| Cafe (5 dB)                         | 39.4% | 39.4%                | 39.4%             | 43.5%              |
| Babble, eight voices (5 dB)         | 30.6% | 30.6%                | 30.6%             | 35.8%              |
| Street (0 dB)                       | 18.7% | 19.3%                | 19.3%             | 20.1%              |

What this says:

- **The filter pays on hum.** It catches most hum within a second: 33 of 363 words are lost
  without it and 6 with it.
- **Always on costs words in a cafe and in babble:** 15 and 19 more of 363. Speech-band noise is
  not something a linear filter can take out, and reshaping the voice under it costs the ASR words.
  `detect` leaves both lines untouched.
- **Clean lines are untouched.** The test checks this sample for sample on the clean, cafe and
  babble lines.
- **Street traffic engages the high-pass.** That costs 2 words of 363, within the ASR's own
  variation.
- **Rumble** loud enough to load the mu-law codec is already lost when it reaches us.
- **Vibration, talkers and beeps** are the VAD's and the turn detector's job.

The default rule is enforced by the test. The distribution preselects the filter only while it is
no worse on clean speech and better on noisy speech overall (160.9 against 168.0 percentage
points summed over the nine noisy conditions), with no condition more than 2.5 points worse. The
test fails if:

- a condition gets more than 2.5 points worse with a preset;
- a clean line changes;
- hum stops improving;
- the default no longer earns its place;
- the filter, a preset, the noise or a clip changes without the transcripts being measured again.

Recognition in a cafe needs more than this filter: STT word confidence and doubtful-turn handling
([noisy callers](../../runbooks/noisy-callers.md)), and Scribe's own `filterBackgroundAudio` to
try on a live call.

## Measuring again

Re-run after changing the filter, a preset or a fixture (the regression test says when):

```sh
python3 -m venv ~/vosk/venv && ~/vosk/venv/bin/pip install vosk==0.3.44
curl -Lo ~/vosk/m.zip https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip
unzip -d ~/vosk ~/vosk/m.zip   # sha256 20663dca…54cc7, retrieved 2026-10-07
OVO_ASR_NAME='Vosk 0.3.44, model vosk-model-small-en-in-0.4' \
OVO_ASR_COMMAND="$HOME/vosk/venv/bin/python3 vosk_asr.py $HOME/vosk/vosk-model-small-en-in-0.4" \
  pnpm exec tsx packages/plugin-audio-filter/tests/fixtures/transcript-quality/measure.ts
```

It rewrites `transcripts.json` (896 cases; identical audio is transcribed once, about 5 minutes on
the Mac mini). Any offline ASR that
prints `<file name><TAB><transcript>` per mu-law file can stand in for `vosk_asr.py`. Once real
calls are recorded, add caller audio to `tests/fixtures/phone-speech/` (8 kHz mu-law, inbound
track of a recording export, with the caller's consent) and measure again.
