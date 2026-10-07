"""Offline transcripts for the audio-filter regression (see README.md).

    python3 vosk_asr.py <vosk-model-dir> <file.ulaw>...

Prints one "<file name>\t<transcript>" line per file: 8 kHz mu-law in, Vosk's own resampling.
"""
import json
import struct
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel


def mulaw_to_pcm16(data):
    out = bytearray()
    for byte in data:
        u = ~byte & 0xFF
        magnitude = ((((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 0x07)) - 0x84
        out += struct.pack("<h", -magnitude if u & 0x80 else magnitude)
    return bytes(out)


def main():
    SetLogLevel(-1)
    model = Model(sys.argv[1])
    for path in sys.argv[2:]:
        with open(path, "rb") as handle:
            pcm = mulaw_to_pcm16(handle.read())
        recognizer = KaldiRecognizer(model, 8000)
        for at in range(0, len(pcm), 3200):
            recognizer.AcceptWaveform(pcm[at : at + 3200])
        text = json.loads(recognizer.FinalResult())["text"]
        print(f"{path.rsplit('/', 1)[-1]}\t{text}", flush=True)


if __name__ == "__main__":
    main()
