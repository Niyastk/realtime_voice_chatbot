import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import threading
import webrtcvad
import whisper
import numpy as np
import sounddevice as sd
import scipy.io.wavfile
import os
import tempfile
import collections
import requests
import json
from datetime import datetime

# === CONFIGURATION ===
OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "mistral:latest"
WHISPER_MODEL_NAME = "base.en"
SAMPLE_RATE = 16000
FRAME_DURATION = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION / 1000)
CHANNELS = 1

# === AUDIO BUFFER ===
class AudioBuffer:
    def __init__(self, max_duration_sec=10):
        self.max_frames = int(SAMPLE_RATE / FRAME_SIZE * max_duration_sec)
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

# === MAIN APP ===
class SpeechToLLMApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Speech to LLM - Voice Chatbot")
        self.geometry("650x600")
        self.resizable(False, False)

        # State
        self.listening = False
        self.stop_listening_flag = threading.Event()
        self.silence_duration = tk.DoubleVar(value=1.2)
        self.vad_aggressiveness = tk.IntVar(value=2)

        # Conversation log
        self.conversation = []

        # Whisper and VAD
        self.whisper_model = None
        self.vad = None

        self._build_ui()
        self._load_models_async()

    def _build_ui(self):
        # Top Controls
        control_frame = ttk.Frame(self)
        control_frame.pack(fill="x", padx=10, pady=5)

        self.listen_btn = ttk.Button(control_frame, text="🎤 Start Listening", command=self.toggle_listening, width=20)
        self.listen_btn.grid(row=0, column=0, padx=5)

        ttk.Label(control_frame, text="Silence (s):").grid(row=0, column=1, padx=5)
        silence_spin = ttk.Spinbox(control_frame, from_=0.3, to=2.5, increment=0.1, textvariable=self.silence_duration, width=5)
        silence_spin.grid(row=0, column=2, padx=2)

        ttk.Label(control_frame, text="VAD:").grid(row=0, column=3, padx=5)
        vad_spin = ttk.Spinbox(control_frame, from_=0, to=3, increment=1, textvariable=self.vad_aggressiveness, width=3)
        vad_spin.grid(row=0, column=4, padx=2)

        save_btn = ttk.Button(control_frame, text="💾 Save Conversation", command=self.save_conversation)
        save_btn.grid(row=0, column=5, padx=10)

        # Status Label
        self.status_var = tk.StringVar(value="Ready.")
        status_label = ttk.Label(self, textvariable=self.status_var, foreground="blue")
        status_label.pack(anchor="w", padx=10, pady=2)

        # Conversation Display
        self.chat_display = scrolledtext.ScrolledText(self, state="disabled", wrap="word", font=("Segoe UI", 11))
        self.chat_display.pack(fill="both", expand=True, padx=10, pady=5)

    def _load_models_async(self):
        def loader():
            self._set_status("Loading Whisper model...")
            self.whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
            self._set_status("Ready. Click 'Start Listening' to begin.")
        threading.Thread(target=loader, daemon=True).start()

    def _set_status(self, msg):
        self.status_var.set(msg)
        self.update_idletasks()

    def toggle_listening(self):
        if not self.listening:
            self.listening = True
            self.listen_btn.config(text="⏹ Stop Listening")
            self.stop_listening_flag.clear()
            threading.Thread(target=self.listen_loop, daemon=True).start()
        else:
            self.stop_listening_flag.set()
            self.listen_btn.config(text="🎤 Start Listening")
            self.listening = False
            self._set_status("Listening stopped.")

    def listen_loop(self):
        self._set_status("Listening... Speak now.")
        vad = webrtcvad.Vad(self.vad_aggressiveness.get())
        buffer = AudioBuffer()
        silence_count = 0
        max_silence_frames = int(self.silence_duration.get() * 1000 / FRAME_DURATION)

        try:
            with sd.RawInputStream(samplerate=SAMPLE_RATE,
                                   blocksize=FRAME_SIZE,
                                   dtype='int16',
                                   channels=CHANNELS) as stream:
                while not self.stop_listening_flag.is_set():
                    # --- Listening Phase ---
                    while not self.stop_listening_flag.is_set():
                        audio, _ = stream.read(FRAME_SIZE)
                        is_speech = vad.is_speech(audio, SAMPLE_RATE)
                        self._set_status("Listening: " + ("Speech detected..." if is_speech else "Silence..."))
                        buffer.add(audio)

                        if is_speech:
                            silence_count = 0
                        else:
                            silence_count += 1

                        if silence_count > max_silence_frames and len(buffer.frames) > 5:
                            break

                    if self.stop_listening_flag.is_set():
                        break

                    # --- Pause Listening: Handle response ---
                    self._set_status("Transcribing...")
                    audio_np = buffer.get_audio()
                    text = self.transcribe_audio(audio_np)
                    buffer.reset()
                    silence_count = 0

                    if text:
                        self.display_message("You", text)
                        self._set_status("Ollama is responding...")
                        response = self.stream_ollama_chat(text)
                        self.display_message("Ollama", response)
                        self._set_status("Listening... Speak again!")
                    else:
                        self._set_status("Didn't catch that. Listening...")

        except Exception as e:
            self._set_status(f"Error: {e}")
        finally:
            self.listen_btn.config(text="🎤 Start Listening")
            self.listening = False

    def transcribe_audio(self, audio_data):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
            scipy.io.wavfile.write(tmpfile.name, SAMPLE_RATE, (audio_data * 32767).astype(np.int16))
            tmp_path = tmpfile.name
        text = ""
        try:
            result = self.whisper_model.transcribe(tmp_path, fp16=False)
            text = result["text"].strip()
        except Exception as e:
            messagebox.showerror("Whisper Error", str(e))
        finally:
            os.remove(tmp_path)
        return text

    def stream_ollama_chat(self, prompt):
        headers = {"Content-Type": "application/json"}
        data = {
            "model": OLLAMA_MODEL,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "stream": True
        }
        response_text = ""
        try:
            with requests.post(OLLAMA_URL, headers=headers, json=data, stream=True, timeout=120) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        chunk = json.loads(line.decode('utf-8'))
                        content = chunk.get("message", {}).get("content", "")
                        self.chat_display.config(state="normal")
                        self.chat_display.insert(tk.END, content)
                        self.chat_display.see(tk.END)
                        self.chat_display.config(state="disabled")
                        response_text += content
        except Exception as e:
            messagebox.showerror("Ollama Error", str(e))
        self.chat_display.config(state="normal")
        self.chat_display.insert(tk.END, "\n")
        self.chat_display.config(state="disabled")
        self.conversation.append(("You", prompt))
        self.conversation.append(("Ollama", response_text))
        return response_text

    def display_message(self, sender, message):
        self.chat_display.config(state="normal")
        self.chat_display.insert(tk.END, f"{sender}: {message}\n\n")
        self.chat_display.see(tk.END)
        self.chat_display.config(state="disabled")

    def save_conversation(self):
        if not self.conversation:
            messagebox.showinfo("Save Conversation", "No conversation to save yet.")
            return
        if not os.path.exists("memories"):
            os.makedirs("memories")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"memories/conversation_{timestamp}.txt"
        with open(filename, "w", encoding="utf-8") as f:
            for sender, msg in self.conversation:
                f.write(f"{sender}: {msg}\n\n")
        messagebox.showinfo("Save Conversation", f"Conversation saved to {filename}")

if __name__ == "__main__":
    app = SpeechToLLMApp()
    app.mainloop()
