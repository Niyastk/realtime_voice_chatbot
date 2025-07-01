import eventlet
eventlet.monkey_patch()

from flask import Flask, request, jsonify, send_file, render_template
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
from flask_cors import CORS
import threading
from flask_socketio import SocketIO, emit
import base64

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# --- CONFIG ---
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_MODEL = "mistral:latest"
WHISPER_MODEL_NAME = "base.en"
SAMPLE_RATE = 16000
FRAME_DURATION = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION / 1000)
CHANNELS = 1

conversation = []
llm_history = []
whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
tts_engine = pyttsx3.init()
tts_lock = threading.Lock()

audio_stream_buffers = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided'}), 400
    audio_file = request.files['audio']
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
        audio_file.save(tmpfile)
        tmp_path = tmpfile.name
    text = ""
    try:
        result = whisper_model.transcribe(tmp_path, fp16=False)
        text = result["text"].strip()
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        os.remove(tmp_path)
    return jsonify({'text': text})

@app.route('/chat', methods=['POST'])
def chat():
    global llm_history, conversation
    data = request.get_json()
    prompt = data.get('prompt', '')
    if not prompt:
        return jsonify({'error': 'No prompt provided'}), 400
    llm_history.append({"role": "user", "content": prompt})
    headers = {"Content-Type": "application/json"}
    payload = {
        "model": OLLAMA_MODEL,
        "messages": llm_history,
        "stream": False
    }
    response_text = ""
    try:
        r = requests.post(OLLAMA_URL, headers=headers, json=payload, timeout=120)
        r.raise_for_status()
        result = r.json()
        response_text = result.get("message", {}).get("content", "")
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    conversation.append(("You", prompt))
    conversation.append(("Ollama", response_text))
    llm_history.append({"role": "assistant", "content": response_text})
    return jsonify({'response': response_text})

@app.route('/save', methods=['POST'])
def save_conversation():
    global conversation
    if not conversation:
        return jsonify({'error': 'No conversation to save'}), 400
    if not os.path.exists("memories"):
        os.makedirs("memories")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"memories/conversation_{timestamp}.txt"
    with open(filename, "w", encoding="utf-8") as f:
        for sender, msg in conversation:
            f.write(f"{sender}: {msg}\n\n")
    return jsonify({'message': f'Conversation saved to {filename}'})

@app.route('/clear', methods=['POST'])
def clear_memory():
    global llm_history
    llm_history = []
    return jsonify({'message': 'Chat memory cleared.'})

@socketio.on('chat')
def handle_chat_socket(data):
    global llm_history, conversation
    prompt = data.get('prompt', '')
    if not prompt:
        emit('chat_response', {'error': 'No prompt provided'})
        return
    llm_history.append({"role": "user", "content": prompt})
    headers = {"Content-Type": "application/json"}
    payload = {
        "model": OLLAMA_MODEL,
        "messages": llm_history,
        "stream": True
    }
    response_text = ""
    try:
        with requests.post(OLLAMA_URL, headers=headers, json=payload, stream=True, timeout=120) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line:
                    chunk = json.loads(line.decode('utf-8'))
                    content = chunk.get("message", {}).get("content", "")
                    if content:
                        emit('chat_response', {'content': content})
                        response_text += content
                        socketio.sleep(0)
    except Exception as e:
        emit('chat_response', {'error': str(e)})
        return
    conversation.append(("You", prompt))
    conversation.append(("Ollama", response_text))
    llm_history.append({"role": "assistant", "content": response_text})
    emit('chat_response', {'done': True})

@socketio.on('whisper_stream')
def handle_whisper_stream(data):
    sid = request.sid
    action = data.get('action')
    N_SECONDS = 5
    if action == 'start':
        audio_stream_buffers[sid] = b''
        emit('whisper_partial', {'partial': ''})
    elif action == 'audio':
        if sid not in audio_stream_buffers:
            emit('whisper_partial', {'error': 'Session not initialized. Please restart streaming.'})
            return
        chunk = data.get('audio')
        if chunk is not None:
            audio_bytes = base64.b64decode(chunk)
            audio_stream_buffers[sid] += audio_bytes
            # Lower latency: run Whisper on last N seconds only for partials
            bytes_per_sample = 2  # int16
            samples_per_second = SAMPLE_RATE
            n_samples = N_SECONDS * samples_per_second
            total_samples = len(audio_stream_buffers[sid]) // bytes_per_sample
            start_sample = max(0, total_samples - n_samples)
            partial_bytes = audio_stream_buffers[sid][start_sample * bytes_per_sample:]
            # Real-time partial transcription: run Whisper on the last N seconds
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmpfile:
                scipy.io.wavfile.write(tmpfile.name, SAMPLE_RATE, np.frombuffer(partial_bytes, dtype=np.int16))
                tmp_path = tmpfile.name
            try:
                result = whisper_model.transcribe(tmp_path, fp16=False)
                partial = result['text'].strip()
                emit('whisper_partial', {'partial': partial})
            except Exception as e:
                emit('whisper_partial', {'error': str(e)})
            finally:
                os.remove(tmp_path)
    elif action == 'stop':
        if sid not in audio_stream_buffers:
            emit('whisper_final', {'error': 'Session not initialized. Please restart streaming.'})
            return
        buffer = audio_stream_buffers.pop(sid, b'')
        if buffer:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmpfile:
                scipy.io.wavfile.write(tmpfile.name, SAMPLE_RATE, np.frombuffer(buffer, dtype=np.int16))
                tmp_path = tmpfile.name
            try:
                result = whisper_model.transcribe(tmp_path, fp16=False)
                final = result['text'].strip()
                emit('whisper_final', {'final': final})
            except Exception as e:
                emit('whisper_final', {'error': str(e)})
            finally:
                os.remove(tmp_path)
        else:
            emit('whisper_final', {'final': ''})

if __name__ == "__main__":
    socketio.run(app, debug=True) 