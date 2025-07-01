import webrtcvad
import whisper
import numpy as np
import sounddevice as sd
import scipy.io.wavfile
import os
import tempfile
import collections
import subprocess

# Load Whisper model
print("Loading Whisper model...")
model = whisper.load_model("base.en")  # or "tiny" or "small" for speed

# Audio settings
sample_rate = 16000
frame_duration = 30  # ms
frame_size = int(sample_rate * frame_duration / 1000)
channels = 1

# Initialize VAD
vad = webrtcvad.Vad(2)  # Aggressiveness: 0 to 3

# Buffer to collect frames while speaking
class AudioBuffer:
    def __init__(self, max_duration_sec=10):
        self.max_frames = int(sample_rate / frame_size * max_duration_sec)
        self.frames = collections.deque()

    def add(self, frame):
        if len(self.frames) >= self.max_frames:
            self.frames.popleft()
        self.frames.append(frame)

    def reset(self):
        self.frames.clear()

    def get_audio(self):
        pcm_data = b''.join(self.frames)
        audio_np = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
        return audio_np.reshape(-1, 1)

# Transcribe audio with Whisper
def transcribe_audio(audio_data):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
        scipy.io.wavfile.write(tmpfile.name, sample_rate, (audio_data * 32767).astype(np.int16))
        tmp_path = tmpfile.name

    text = ""
    try:
        result = model.transcribe(tmp_path, fp16=False)
        text = result["text"].strip()
        if text:
            print(f"\n📝 You said: {text}")
    except Exception as e:
        print(f"❌ Whisper Error: {e}")
    finally:
        os.remove(tmp_path)
    return text

# Send prompt to Ollama and get response
def query_ollama(prompt, model_name="mistral:latest"):
    try:
        result = subprocess.run(
            ["ollama", "query", model_name, prompt],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"❌ Ollama Error: {e.stderr}")
        return ""

# Main VAD listening loop
def vad_listen():
    print("🎤 Listening... Start speaking. Press Ctrl+C to stop.\n")

    buffer = AudioBuffer()
    silence_count = 0
    max_silence_frames = int(0.8 * 1000 / frame_duration)  # 0.8 seconds silence

    with sd.RawInputStream(samplerate=sample_rate,
                           blocksize=frame_size,
                           dtype='int16',
                           channels=channels) as stream:
        try:
            while True:
                audio, _ = stream.read(frame_size)
                is_speech = vad.is_speech(audio, sample_rate)

                buffer.add(audio)

                if is_speech:
                    silence_count = 0
                else:
                    silence_count += 1

                # On silence after speech, transcribe and query LLM
                if silence_count > max_silence_frames and len(buffer.frames) > 5:
                    audio_np = buffer.get_audio()
                    text = transcribe_audio(audio_np)
                    buffer.reset()
                    silence_count = 0

                    if text:
                        print("💬 Querying LLM...")
                        response = query_ollama(text)
                        print(f"\n🤖 LLM Response:\n{response}\n")

        except KeyboardInterrupt:
            print("\n🛑 Exiting...")

if __name__ == "__main__":
    vad_listen()
