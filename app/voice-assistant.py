"""Voice assistant: mic -> whisper-server (:8081) -> llama server (:8080) -> speech
(Windows SAPI voices, on Linux/macOS espeak-ng).

Start scripts/start-llama and scripts/start-whisper (.ps1 / .sh) first, then: python app/voice-assistant.py
Speak after "Listening...". The assistant stops listening while it talks. Ctrl+C quits.
"""
import io
import json
import re
import shutil
import subprocess
import sys
import wave

import numpy as np
import requests
import sounddevice as sd

WHISPER_URL = "http://127.0.0.1:8081/inference"
LLAMA_URL = "http://127.0.0.1:8080/v1/chat/completions"
VOICES = {"german": "Hedda", "english": "Zira"}  # Windows voice per detected language
ESPEAK_VOICES = {"german": "de", "english": "en"}  # espeak-ng voice per detected language (Linux/macOS)

RATE = 16000
BLOCK = 480                # 30 ms
START_FACTOR = 3.0         # speech starts when energy > noise floor * this
SILENCE_END_S = 0.9        # this much silence ends an utterance
MIN_SPEECH_S = 0.4
MAX_SPEECH_S = 30

SYSTEM_PROMPT = (
    "You are a voice assistant. Your answers are spoken aloud, so keep them short "
    "(1-3 sentences), conversational, and without markdown, lists, code or emojis. "
    "Answer in the language the user speaks."
)

if sys.platform == "win32":
    import win32com.client

    speaker = win32com.client.Dispatch("SAPI.SpVoice")

    def set_voice(lang):
        want = VOICES.get(lang, VOICES["english"])
        for v in speaker.GetVoices():
            if want in v.GetDescription():
                speaker.Voice = v
                return

    def speak(text):
        text = text.strip()
        if text:
            speaker.Speak(text)

else:
    ESPEAK = shutil.which("espeak-ng") or shutil.which("espeak")
    if not ESPEAK:
        sys.exit("espeak-ng not found - install it (e.g. sudo apt install espeak-ng)")
    espeak_voice = "en"

    def set_voice(lang):
        global espeak_voice
        espeak_voice = ESPEAK_VOICES.get(lang, "en")

    def speak(text):
        text = text.strip()
        if text:
            subprocess.run([ESPEAK, "-v", espeak_voice, text], check=False)


def calibrate(stream):
    levels = [np.sqrt(np.mean(stream.read(BLOCK)[0].astype(np.float32) ** 2)) for _ in range(30)]
    return max(np.median(levels), 50.0)


def record_utterance(stream, noise):
    """Blocks until one utterance has been spoken, returns int16 samples."""
    threshold = noise * START_FACTOR
    pre_roll, frames, silent, speaking = [], [], 0, False
    while True:
        block = stream.read(BLOCK)[0][:, 0]
        level = np.sqrt(np.mean(block.astype(np.float32) ** 2))
        if not speaking:
            pre_roll = (pre_roll + [block])[-10:]
            if level > threshold:
                speaking, frames = True, list(pre_roll)
            continue
        frames.append(block)
        silent = silent + 1 if level < threshold else 0
        duration = len(frames) * BLOCK / RATE
        if silent * BLOCK / RATE >= SILENCE_END_S or duration >= MAX_SPEECH_S:
            if duration - SILENCE_END_S >= MIN_SPEECH_S:
                return np.concatenate(frames)
            pre_roll, frames, silent, speaking = [], [], 0, False


def transcribe(samples):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())
    r = requests.post(
        WHISPER_URL,
        files={"file": ("speech.wav", buf.getvalue(), "audio/wav")},
        data={"response_format": "verbose_json", "temperature": "0.0"},
        timeout=60,
    )
    r.raise_for_status()
    result = r.json()
    text = result.get("text", "").strip()
    # whisper hallucinates these on noise
    if re.fullmatch(r"[\[\(].*[\]\)]|\W*", text):
        text = ""
    return text, result.get("language", "english")


def chat(history):
    """Streams the reply and speaks it sentence by sentence. Returns the full reply."""
    r = requests.post(
        LLAMA_URL,
        json={
            "messages": history,
            "stream": True,
            "chat_template_kwargs": {"enable_thinking": False},
        },
        stream=True,
        timeout=300,
    )
    r.raise_for_status()
    reply, pending = "", ""
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: ") or line == "data: [DONE]":
            continue
        delta = json.loads(line[6:])["choices"][0].get("delta", {})
        piece = delta.get("content") or ""
        reply += piece
        pending += piece
        print(piece, end="", flush=True)
        # speak each finished sentence while the rest is still generating
        *done, pending = re.split(r"(?<=[.!?])\s+", pending)
        for sentence in done:
            speak(sentence)
    speak(pending)
    print()
    return reply


def main():
    history = [{"role": "system", "content": SYSTEM_PROMPT}]
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=BLOCK) as stream:
        print("Calibrating noise level, stay quiet for a second...")
        noise = calibrate(stream)
        while True:
            print("\nListening...")
            samples = record_utterance(stream, noise)
            stream.stop()  # don't record ourselves while thinking/speaking
            text, lang = transcribe(samples)
            if text:
                print(f"You ({lang}): {text}")
                print("Assistant: ", end="", flush=True)
                set_voice(lang)
                history.append({"role": "user", "content": text})
                history.append({"role": "assistant", "content": chat(history)})
            stream.start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except requests.ConnectionError as e:
        sys.exit(f"Server not reachable - are start-llama and start-whisper running?\n{e}")
