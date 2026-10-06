# STT bake-off (STT-10)

This harness compares **ElevenLabs Scribe v2 realtime**, **AssemblyAI** and **Sarvam Saaras** on Indian English and Hinglish caller audio. It measures:

- **WER**: corpus-level word error rate, also split into Indian English and Hinglish.
- **First partial**: time from the first audio byte to the first transcript text, p50 and p95.
- **Final after audio**: time from the last caller audio byte to the last final transcript, p50 and p95. This is the number that adds to end-of-speech latency.
- **₹ per audio hour**: the metered usage priced with `prices.json`.

Each provider runs through its **production OVO plugin** with the host's format adapter, configured the way the collections agent binds it (`providers.ts`):

| Contestant | Model                | Binding                                                     |
| ---------- | -------------------- | ----------------------------------------------------------- |
| Scribe     | `scribe_v2_realtime` | Manual commit 250 ms after the speech, language auto-detect |
| AssemblyAI | `universal-3-6-pro`  | US region, `fast` endpointing                               |
| Sarvam     | `saaras:v3-realtime` | `codemix` mode                                              |

## Offline (default, no network)

```bash
pnpm exec tsx scripts/stt-bakeoff/cli.ts                     # the committed fixture corpus
pnpm exec tsx scripts/stt-bakeoff/cli.ts --corpus <dir>      # a recorded corpus
pnpm exec tsx scripts/stt-bakeoff/cli.ts --providers scribe,sarvam --json
```

Offline mode reads `<corpus>/corpus.json` and `<corpus>/recordings/<provider>/<utterance>.json` and only scores them.

**The committed corpus in `fixtures/` is synthetic.** The references and transcripts are made up to exercise the harness, and the report says so in bold. Do not quote its numbers.

## Recording a real corpus (live, explicit keys only)

1. Collect consented caller audio: about 30 utterances or more, half Indian English and half Hinglish, cut to one caller turn each. Phone-quality audio is the point, so take turns from call recordings or record over a phone line. Save each turn as a mono WAV, either 8 kHz mu-law (WAV format 7) or 16-bit PCM at 8 or 16 kHz.
2. Write `corpus.json` next to the WAVs:

   ```json
   {
     "utterances": [
       {
         "id": "hi-ptp-01",
         "language": "hi-IN",
         "style": "hinglish",
         "reference": "haan main kal tak payment kar dunga",
         "accept": ["हाँ मैं कल तक payment कर दूंगा"],
         "audio": "hi-ptp-01.wav"
       }
     ]
   }
   ```

   The `reference` is a careful human transcript. List other correct spellings in `accept`: a Devanagari rendering of Hindi words, or digits written as words. The WER uses the closest one. Numbers are compared as written (`4,210` and `4210` match; `four thousand two hundred ten` does not).

3. Run with keys for exactly the providers you want. Live mode refuses to start unless every chosen provider's variable is set and every utterance has audio:

   ```bash
   OVO_BAKEOFF_ELEVENLABS_API_KEY=… OVO_BAKEOFF_ASSEMBLYAI_API_KEY=… OVO_BAKEOFF_SARVAM_API_KEY=… \
     pnpm exec tsx scripts/stt-bakeoff/cli.ts --corpus <dir> --live
   ```

   Each utterance streams in real time as 20 ms frames, followed by 250 ms of silence and a commit where the provider needs one. The run then waits up to 4 s for the final and closes the session gracefully, so usage is reconciled. Transcripts are saved under `<dir>/recordings/` and scored. Rerunning offline later needs no keys.

**Costs:** a live run bills each provider for the audio. Scribe also bills keyterm prompting extra, but the bake-off sends no keyterms.

**Network placement:** run live mode from the asia-south1 VM, or the latency columns describe your laptop's network, not the product's. Never run it against real calls; it only reads the corpus WAVs.

## Reading the result

The table gives one row per provider. Under it, each utterance's transcript is listed for spot checks. Weigh the Hinglish WER and the final-after-audio p95 most heavily: they decide whether Jev hears the reply and how long the caller waits. Record the decision and the corpus description in the founder's notes. Then set the agent's STT binding, and its language preset where it applies.
