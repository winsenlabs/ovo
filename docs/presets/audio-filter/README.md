# Audio filter presets for phone calls

The telephony audio filter (`@winsendotai/ovo-audio-filter-telephony`) cleans the caller's audio
before the VAD and the STT hear it: a 100 Hz high-pass for handling rumble, notches on 50 Hz mains
hum and its harmonics, and an optional noise gate. It is **off by default**: an agent gets it only
when its `voice.audioFilter` selects it. The VAD's own 200 Hz high-pass and its tone and vibration
rejection run on every call either way.

## Turning it on for one agent

Add one line to the agent's `voice` block. The plugin's defaults are the recommended phone row
(`telephony.json`), so no `config` is needed:

```json
{ "voice": { "audioFilter": { "plugin": "@winsendotai/ovo-audio-filter-telephony" } } }
```

To pin the row explicitly, or to use another preset, paste the preset file as the value:

| Preset                 | When                                                                 | Row                                                |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `telephony.json`       | Recommended for 8 kHz calls from India: rumble and hum, nothing else | high-pass 100 Hz, 50 Hz hum ×4 harmonics, no gate  |
| `telephony-noisy.json` | Callers in steady noise (fans, traffic), after comparing transcripts | the same, plus a downward expander (10 dB / 12 dB) |

For mains at 60 Hz (the Americas) set `hum.mainsHz` to 60. Publishing the release is enough; the
filter adds under 1 ms of delay and no buffering, so turn-taking latency does not change.

## What it does to transcripts

`packages/plugin-audio-filter/tests/transcript-quality.test.ts` compares transcripts with the
filter off and with each preset. The speech is real 8 kHz mu-law: eight agent lines from the live
CreditMantri release's pre-rendered clips. No caller audio exists to use (live calls were not
recorded), so the line noise is added on top, seeded and repeatable
(`tests/fixtures/phone-noise.ts`). The transcripts come from an offline Indian-English ASR (Vosk,
`vosk-model-small-en-in-0.4`), not from Scribe: no provider key is used in tests. The word error
rate is against the same ASR's transcript of the clean clip, so it measures only what the noise
and the filter change. Each condition has 121 reference words, so one word is about 0.8 points.

Measured 2026-10-07:

| Condition (speech-to-noise)         | Off   | `telephony` | `telephony-noisy` |
| ----------------------------------- | ----- | ----------- | ----------------- |
| Clean line                          | 0.0%  | 0.0%        | 0.0%              |
| Handling rumble and thumps (-5 dB)  | 31.4% | 32.2%       | 32.2%             |
| 50 Hz mains hum (0 dB)              | 9.1%  | 0.8%        | 0.8%              |
| Phone vibrating, 175 Hz (5 dB)      | 6.6%  | 8.3%        | 8.3%              |
| Steady fan or traffic noise (10 dB) | 9.1%  | 7.4%        | 7.4%              |
| Three background talkers (10 dB)    | 28.9% | 29.8%       | 28.9%             |
| 1 kHz beeps (5 dB)                  | 0.8%  | 0.0%        | 0.0%              |

What this says:

- **Hum** is where the filter pays: 11 of 121 words lost without it, 1 with it.
- **Clean lines are untouched**: every transcript is identical with the filter on.
- **Rumble** loud enough to load the mu-law codec is already lost when it reaches us: the
  filter removes the rumble but cannot restore the speech the codec quantised under it. Real
  networks (AMR's own 80 Hz high-pass) usually take most of it out before the carrier does.
- **Vibration, talkers and beeps** are the VAD's and the turn detector's job (Wave 6): the filter
  neither helps nor hurts beyond one or two words, which is within the ASR's own variation.
- The gate changes nothing measurable for this ASR. Keep it for agents whose callers are in steady
  noise and check their transcripts first.

The test fails if any condition gets more than 2.5 points worse with a preset, if a clean line
changes, if hum stops improving, or if the filter, a preset, the noise or a clip changes without
the transcripts being measured again.

## Turning it on by default

Not yet. The Wave 6 decision stands: one live call with `voice.audioFilter` set must show Scribe's
transcripts are no worse (the Wave 6 post-merge checklist, item 12). This measurement supports
doing so: no condition gets worse beyond the ASR's noise, and hum, which cheap chargers and
handsets put on Indian lines, improves sharply. Making it the default is the Wave 6 noise lane's
cross-lane diff (`DISTRIBUTION_DEFAULTS.audioFilter`, preselected with the energy VAD for a
manual-commit STT; an agent's own selection still wins), applied once that call passes.

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

It rewrites `transcripts.json` (168 transcripts, about 100 s on the Mac mini). Any offline ASR that
prints `<file name><TAB><transcript>` per mu-law file can stand in for `vosk_asr.py`. Once real
calls are recorded, add caller audio to `tests/fixtures/phone-speech/` (8 kHz mu-law, inbound
track of a recording export, with the caller's consent) and measure again.
