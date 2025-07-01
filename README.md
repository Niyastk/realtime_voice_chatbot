# Realtime Voice Chatbot (Web)

A modern, full-stack, real-time voice chatbot web app with streaming LLM (Ollama), Whisper transcription, and a premium ChatGPT-style UI.

## Features

- **Real-time streaming LLM responses** (Ollama, via Flask-SocketIO)
- **Live transcription**: 
  - Web Speech API (browser, instant, word-by-word)
  - Whisper (offline, streaming, accurate)
  - Audio upload (Whisper, accurate)
- **Modern chat UI**: 
  - ChatGPT-style bubbles, avatars, timestamps, typing indicator
  - Responsive, full-screen layout
  - Dark/light mode & premium color themes
  - Microphone visualizer for all recording modes
- **Custom Markdown rendering**: 
  - Code blocks, inline code, bullet and numbered lists
- **TTS (Text-to-Speech)**: Toggle bot voice output
- **Save/Clear conversation memory**
- **Robust session and error handling**

## Installation

### 1. Python Environment

Create and activate a virtual environment (recommended):

```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

### 2. Install Python Dependencies

Create a `requirements.txt` with the following content:

```
flask
flask-socketio
eventlet
flask-cors
requests
webrtcvad
openai-whisper
numpy
sounddevice
scipy
pyttsx3
```

Then install:

```bash
pip install -r requirements.txt
```

### 3. Install System Dependencies

- **ffmpeg** (required for Whisper audio conversion)
- **Ollama** (for LLM backend, e.g., `mistral:latest`)

On Ubuntu:

```bash
sudo apt-get install ffmpeg
```

On Windows: [Download ffmpeg](https://ffmpeg.org/download.html) and add to PATH.

Install Ollama from [https://ollama.com/](https://ollama.com/) and run your desired model (e.g., `ollama run mistral`).

### 4. Run the App

Start the Flask-SocketIO server:

```bash
python app.py
```

Visit [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser.

## Usage

- Type or speak your prompt.
- Choose transcription mode (Web Speech, Whisper streaming, or audio upload).
- Toggle TTS for bot voice.
- Save or clear conversation as needed.
- Enjoy real-time, Markdown-formatted, streaming LLM chat!

## File Structure

```
app.py                # Flask backend (API, SocketIO, streaming)
static/
  app.js              # Frontend JS (UI, socket, streaming, Markdown)
  style.css           # Modern chat UI styles
templates/
  index.html          # Main web page
memories/             # Saved conversations
```

## Notes

- Ollama and Whisper models must be downloaded before use.
- For best streaming, use Chrome or Edge.
- If you change backend code, always restart the server. 