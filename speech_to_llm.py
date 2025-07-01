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
import pyttsx3
import re

# --- CONFIG ---
OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "mistral:latest"
WHISPER_MODEL_NAME = "base.en"
SAMPLE_RATE = 16000
FRAME_DURATION = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION / 1000)
CHANNELS = 1

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

class SpeechToLLMApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Speech to LLM - Voice Chatbot")
        self.geometry("700x700")
        self.resizable(False, False)

        # State
        self.listening = False
        self.stop_listening_flag = threading.Event()
        self.silence_duration = tk.DoubleVar(value=1.2)
        self.vad_aggressiveness = tk.IntVar(value=2)
        self.tts_enabled = tk.BooleanVar(value=True)
        self.listen_mode = tk.StringVar(value="continuous")  # or "push"
        self.conversation = []
        self.whisper_model = None
        self.tts_engine = pyttsx3.init()
        self.tts_lock = threading.Lock()

        self._build_ui()
        self._load_models_async()

    def _build_ui(self):
        # Menu bar for settings
        menubar = tk.Menu(self)
        settings_menu = tk.Menu(menubar, tearoff=0)
        settings_menu.add_checkbutton(label="Enable TTS", variable=self.tts_enabled)
        menubar.add_cascade(label="Settings", menu=settings_menu)
        self.config(menu=menubar)

        # Controls
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

        self.status_var = tk.StringVar(value="Ready.")
        status_label = ttk.Label(self, textvariable=self.status_var, foreground="blue")
        status_label.pack(anchor="w", padx=10, pady=2)

        self.chat_display = scrolledtext.ScrolledText(self, state="disabled", wrap="word", font=("Segoe UI", 11))
        self.chat_display.pack(fill="both", expand=True, padx=10, pady=5)

        # --- Text input for typing ---
        input_frame = ttk.Frame(self)
        input_frame.pack(fill="x", padx=10, pady=5)
        self.text_entry = ttk.Entry(input_frame, font=("Segoe UI", 11))
        self.text_entry.pack(side="left", fill="x", expand=True, padx=(0, 5))
        self.text_entry.bind("<Return>", self.send_text_prompt)
        send_btn = ttk.Button(input_frame, text="Send", command=self.send_text_prompt)
        send_btn.pack(side="right")

    def _load_models_async(self):
        def loader():
            self._set_status("Loading Whisper model...")
            self.whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
            self._set_status("Ready. Click 'Start Listening' or type a prompt.")
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
        # Continuous listening: auto-restarts after each response
        while not self.stop_listening_flag.is_set():
            self.listen_once(auto_restart=True)

    def listen_once(self, auto_restart=False):
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
                    return
                self._set_status("Transcribing...")
                audio_np = buffer.get_audio()
                text = self.transcribe_audio(audio_np)
                buffer.reset()
                silence_count = 0
                if text:
                    self.display_message("You", text)
                    self._set_status("Ollama is responding...")
                    response = self.stream_ollama_chat_with_tts(text)
                    self.display_message("Ollama", response)
                    self._set_status("Listening... Speak again!" if auto_restart else "Ready.")
                else:
                    self._set_status("Didn't catch that. Listening...")
        except Exception as e:
            self._set_status(f"Error: {e}")
        finally:
            if not auto_restart:
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

    def stream_ollama_chat_with_tts(self, prompt):
        headers = {"Content-Type": "application/json"}
        data = {
            "model": OLLAMA_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True
        }
        response_text = ""
        buffer = ""
        sentence_end = re.compile(r'([.!?])')
        def speak(text):
            if self.tts_enabled.get() and text.strip():
                def tts_worker():
                    with self.tts_lock:
                        self.tts_engine.say(text)
                        self.tts_engine.runAndWait()
                threading.Thread(target=tts_worker, daemon=True).start()
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
                        buffer += content
                        while True:
                            match = sentence_end.search(buffer)
                            if match:
                                idx = match.end()
                                sentence = buffer[:idx]
                                speak(sentence)
                                buffer = buffer[idx:]
                            else:
                                break
        except Exception as e:
            messagebox.showerror("Ollama Error", str(e))
        if buffer.strip():
            speak(buffer.strip())
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

    def send_text_prompt(self, event=None):
        prompt = self.text_entry.get().strip()
        if not prompt:
            return
        self.text_entry.delete(0, tk.END)
        self.display_message("You", prompt)
        self._set_status("Ollama is responding...")
        threading.Thread(target=self._handle_text_prompt, args=(prompt,), daemon=True).start()

    def _handle_text_prompt(self, prompt):
        response = self.stream_ollama_chat_with_tts(prompt)
        self.display_message("Ollama", response)
        self._set_status("Ready.")

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
