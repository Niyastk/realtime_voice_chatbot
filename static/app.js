const chatDisplay = document.getElementById('chat-display');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const recordBtn = document.getElementById('record-btn');
const saveBtn = document.getElementById('save-btn');
const clearBtn = document.getElementById('clear-btn');
const ttsToggle = document.getElementById('tts-toggle');
const statusDiv = document.getElementById('status');
const modeSelect = document.getElementById('transcribe-mode');

let conversation = [];
let isRecording = false;
let mediaRecorder;
let audioChunks = [];
let socket = io();

// Add live transcribe button
const liveBtn = document.createElement('button');
liveBtn.id = 'live-btn';
liveBtn.textContent = '📝 Live Transcribe';
document.querySelector('.controls').appendChild(liveBtn);

const stopLiveBtn = document.createElement('button');
stopLiveBtn.id = 'stop-live-btn';
stopLiveBtn.textContent = '⏹ Stop Live';
stopLiveBtn.style.display = 'none';
document.querySelector('.controls').appendChild(stopLiveBtn);

let recognition;
let isRecognizing = false;
let liveTranscript = '';
let silenceTimeout;

let whisperStreamActive = false;
let whisperMediaRecorder;
let whisperAudioChunks = [];
let whisperSilenceTimeout;
let whisperAudioContext;
let whisperSourceNode;
let whisperAnalyser;
let whisperSilenceThreshold = 0.01; // Adjust as needed
let whisperSilenceDuration = 2000; // ms

function appendMessage(sender, message) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'msg';
    msgDiv.innerHTML = `<b>${sender}:</b> ${message}`;
    chatDisplay.appendChild(msgDiv);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
}

function setStatus(msg) {
    statusDiv.textContent = msg;
}

sendBtn.onclick = async () => {
    const prompt = textInput.value.trim();
    if (!prompt) return;
    textInput.value = '';
    appendMessage('You', prompt);
    setStatus('Ollama is responding...');
    conversation.push(['You', prompt]);
    let response = '';
    let done = false;
    // Use socket for streaming
    socket.emit('chat', { prompt });
    socket.on('chat_response', function handler(data) {
        if (data.error) {
            appendMessage('Ollama', '[Error: ' + data.error + ']');
            setStatus('Ready.');
            socket.off('chat_response', handler);
            return;
        }
        if (data.content) {
            response += data.content;
            // Stream update
            if (!done) {
                // Remove last Ollama message if present
                let last = chatDisplay.lastElementChild;
                if (last && last.className === 'msg' && last.innerHTML.startsWith('<b>Ollama:</b>')) {
                    last.innerHTML = `<b>Ollama:</b> ${response}`;
                } else {
                    appendMessage('Ollama', data.content);
                }
            }
        }
        if (data.done) {
            conversation.push(['Ollama', response]);
            if (ttsToggle.checked) speakText(response);
            setStatus('Ready.');
            socket.off('chat_response', handler);
            done = true;
        }
    });
};

textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendBtn.onclick();
});

recordBtn.onclick = async () => {
    if (isRecording) {
        mediaRecorder.stop();
        setStatus('Processing audio...');
        recordBtn.textContent = '🎤 Record';
        isRecording = false;
    } else {
        if (!navigator.mediaDevices) {
            alert('Audio recording not supported.');
            return;
        }
        setStatus('Recording...');
        recordBtn.textContent = '⏹ Stop';
        audioChunks = [];
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'audio.wav');
            try {
                const res = await fetch('/transcribe', { method: 'POST', body: formData });
                const data = await res.json();
                if (data.text) {
                    appendMessage('You', data.text);
                    conversation.push(['You', data.text]);
                    setStatus('Ollama is responding...');
                    // Send to chat via socket for streaming
                    let response = '';
                    let done = false;
                    socket.emit('chat', { prompt: data.text });
                    socket.on('chat_response', function handler(data) {
                        if (data.error) {
                            appendMessage('Ollama', '[Error: ' + data.error + ']');
                            setStatus('Ready.');
                            socket.off('chat_response', handler);
                            return;
                        }
                        if (data.content) {
                            response += data.content;
                            // Stream update
                            if (!done) {
                                let last = chatDisplay.lastElementChild;
                                if (last && last.className === 'msg' && last.innerHTML.startsWith('<b>Ollama:</b>')) {
                                    last.innerHTML = `<b>Ollama:</b> ${response}`;
                                } else {
                                    appendMessage('Ollama', data.content);
                                }
                            }
                        }
                        if (data.done) {
                            conversation.push(['Ollama', response]);
                            if (ttsToggle.checked) speakText(response);
                            setStatus('Ready.');
                            socket.off('chat_response', handler);
                            done = true;
                        }
                    });
                } else {
                    appendMessage('You', '[Could not transcribe audio]');
                }
            } catch (e) {
                appendMessage('You', '[Error: ' + e + ']');
            }
            setStatus('Ready.');
        };
        mediaRecorder.start();
        isRecording = true;
    }
};

saveBtn.onclick = async () => {
    setStatus('Saving conversation...');
    try {
        const res = await fetch('/save', { method: 'POST' });
        const data = await res.json();
        setStatus(data.message || data.error);
    } catch (e) {
        setStatus('Error saving: ' + e);
    }
};

clearBtn.onclick = async () => {
    setStatus('Clearing memory...');
    try {
        const res = await fetch('/clear', { method: 'POST' });
        const data = await res.json();
        setStatus(data.message || data.error);
        chatDisplay.innerHTML = '';
        conversation = [];
    } catch (e) {
        setStatus('Error clearing: ' + e);
    }
};

function speakText(text) {
    if (!('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utter);
}

liveBtn.onclick = () => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        alert('Web Speech API is not supported in this browser.');
        return;
    }
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    liveTranscript = '';
    isRecognizing = true;
    liveBtn.style.display = 'none';
    stopLiveBtn.style.display = '';
    setStatus('Listening (Web Speech)...');
    recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                liveTranscript += event.results[i][0].transcript;
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        // Show live transcript (final + interim)
        let liveMsg = document.getElementById('live-msg');
        if (!liveMsg) {
            liveMsg = document.createElement('div');
            liveMsg.className = 'msg';
            liveMsg.id = 'live-msg';
            chatDisplay.appendChild(liveMsg);
        }
        liveMsg.innerHTML = `<b>You (live):</b> ${liveTranscript + interim}`;
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
        // Reset silence timer
        clearTimeout(silenceTimeout);
        silenceTimeout = setTimeout(() => {
            if (liveTranscript.trim()) {
                // Remove live message
                if (liveMsg) liveMsg.remove();
                appendMessage('You', liveTranscript.trim());
                conversation.push(['You', liveTranscript.trim()]);
                setStatus('Ollama is responding...');
                // Send to Ollama via socket
                let response = '';
                let done = false;
                socket.emit('chat', { prompt: liveTranscript.trim() });
                socket.on('chat_response', function handler(data) {
                    if (data.error) {
                        appendMessage('Ollama', '[Error: ' + data.error + ']');
                        setStatus('Ready.');
                        socket.off('chat_response', handler);
                        return;
                    }
                    if (data.content) {
                        response += data.content;
                        if (!done) {
                            let last = chatDisplay.lastElementChild;
                            if (last && last.className === 'msg' && last.innerHTML.startsWith('<b>Ollama:</b>')) {
                                last.innerHTML = `<b>Ollama:</b> ${response}`;
                            } else {
                                appendMessage('Ollama', data.content);
                            }
                        }
                    }
                    if (data.done) {
                        conversation.push(['Ollama', response]);
                        if (ttsToggle.checked) speakText(response);
                        setStatus('Ready.');
                        socket.off('chat_response', handler);
                        done = true;
                    }
                });
                liveTranscript = '';
            }
        }, 2000); // 2 seconds of silence
    };
    recognition.onend = () => {
        isRecognizing = false;
        liveBtn.style.display = '';
        stopLiveBtn.style.display = 'none';
        setStatus('Ready.');
        clearTimeout(silenceTimeout);
        let liveMsg = document.getElementById('live-msg');
        if (liveMsg) liveMsg.remove();
    };
    recognition.onerror = (e) => {
        setStatus('Web Speech error: ' + e.error);
        recognition.stop();
    };
    recognition.start();
};

stopLiveBtn.onclick = () => {
    if (recognition && isRecognizing) {
        recognition.stop();
    }
};

function updateTranscribeMode() {
    const mode = modeSelect.value;
    if (mode === 'webspeech') {
        liveBtn.style.display = '';
        stopLiveBtn.style.display = 'none';
        recordBtn.style.display = 'none';
        if (window.whisperStreamBtn) window.whisperStreamBtn.style.display = 'none';
    } else if (mode === 'audio') {
        liveBtn.style.display = 'none';
        stopLiveBtn.style.display = 'none';
        recordBtn.style.display = '';
        if (window.whisperStreamBtn) window.whisperStreamBtn.style.display = 'none';
    } else if (mode === 'whisper') {
        liveBtn.style.display = 'none';
        stopLiveBtn.style.display = 'none';
        recordBtn.style.display = 'none';
        if (!window.whisperStreamBtn) {
            window.whisperStreamBtn = document.createElement('button');
            window.whisperStreamBtn.id = 'whisper-stream-btn';
            window.whisperStreamBtn.textContent = '🌀 Start Whisper Stream';
            window.whisperStreamBtn.onclick = startWhisperStream;
            document.querySelector('.controls').appendChild(window.whisperStreamBtn);
        }
        window.whisperStreamBtn.style.display = '';
    }
}

modeSelect.onchange = updateTranscribeMode;

// Default to Web Speech mode
updateTranscribeMode();

function startWhisperStream() {
    if (whisperStreamActive) {
        // Stop streaming
        whisperStreamActive = false;
        window.whisperStreamBtn.textContent = '🌀 Start Whisper Stream';
        if (whisperMediaRecorder && whisperMediaRecorder.state !== 'inactive') {
            whisperMediaRecorder.stop();
        }
        if (whisperAudioContext) {
            whisperAudioContext.close();
            whisperAudioContext = null;
        }
        if (whisperSilenceTimeout) {
            clearTimeout(whisperSilenceTimeout);
            whisperSilenceTimeout = null;
        }
        socket.emit('whisper_stream', { action: 'stop' });
        setStatus('Processing final transcript...');
        return;
    }
    // Start streaming
    whisperStreamActive = true;
    window.whisperStreamBtn.textContent = '⏹ Stop Whisper Stream';
    setStatus('Recording (Whisper streaming)...');
    socket.emit('whisper_stream', { action: 'start' });
    whisperAudioChunks = [];
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        whisperMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        whisperMediaRecorder.start(500); // 500ms chunks
        whisperMediaRecorder.ondataavailable = async (e) => {
            if (!whisperStreamActive) return;
            if (e.data && e.data.size > 0) {
                const arrayBuffer = await e.data.arrayBuffer();
                const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                socket.emit('whisper_stream', { action: 'audio', audio: b64 });
            }
        };
        whisperMediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            if (whisperAudioContext) {
                whisperAudioContext.close();
                whisperAudioContext = null;
            }
            if (whisperSilenceTimeout) {
                clearTimeout(whisperSilenceTimeout);
                whisperSilenceTimeout = null;
            }
        };
        // --- Silence detection ---
        whisperAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        whisperSourceNode = whisperAudioContext.createMediaStreamSource(stream);
        whisperAnalyser = whisperAudioContext.createAnalyser();
        whisperAnalyser.fftSize = 2048;
        whisperSourceNode.connect(whisperAnalyser);
        function checkSilence() {
            if (!whisperStreamActive) return;
            const data = new Uint8Array(whisperAnalyser.fftSize);
            whisperAnalyser.getByteTimeDomainData(data);
            // Calculate RMS
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                let val = (data[i] - 128) / 128;
                sum += val * val;
            }
            const rms = Math.sqrt(sum / data.length);
            if (rms < whisperSilenceThreshold) {
                if (!whisperSilenceTimeout) {
                    whisperSilenceTimeout = setTimeout(() => {
                        if (whisperStreamActive) {
                            setStatus('Silence detected, auto-stopping...');
                            startWhisperStream(); // This will stop the stream
                        }
                    }, whisperSilenceDuration);
                }
            } else {
                if (whisperSilenceTimeout) {
                    clearTimeout(whisperSilenceTimeout);
                    whisperSilenceTimeout = null;
                }
            }
            requestAnimationFrame(checkSilence);
        }
        checkSilence();
        // ---
    });
}

// Handle partial and final transcriptions from backend
socket.on('whisper_partial', data => {
    console.log('Whisper partial:', data.partial);
    if (data.error) {
        setStatus('Whisper error: ' + data.error);
        return;
    }
    let liveMsg = document.getElementById('whisper-live-msg');
    if (!liveMsg) {
        liveMsg = document.createElement('div');
        liveMsg.className = 'msg';
        liveMsg.id = 'whisper-live-msg';
        chatDisplay.appendChild(liveMsg);
    }
    if (data.partial && data.partial.trim()) {
        liveMsg.innerHTML = `<b>You (Whisper):</b> ${data.partial}`;
    } else {
        liveMsg.innerHTML = `<b>You (Whisper):</b> <i>Listening...</i>`;
    }
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
});

socket.on('whisper_final', data => {
    let liveMsg = document.getElementById('whisper-live-msg');
    if (liveMsg) liveMsg.remove();
    if (data.error) {
        setStatus('Whisper error: ' + data.error);
        return;
    }
    if (data.final && data.final.trim()) {
        appendMessage('You', data.final.trim());
        conversation.push(['You', data.final.trim()]);
        setStatus('Ollama is responding...');
        // Send to Ollama via socket for streaming response
        let response = '';
        let done = false;
        socket.emit('chat', { prompt: data.final.trim() });
        socket.on('chat_response', function handler(data) {
            if (data.error) {
                appendMessage('Ollama', '[Error: ' + data.error + ']');
                setStatus('Ready.');
                socket.off('chat_response', handler);
                return;
            }
            if (data.content) {
                response += data.content;
                if (!done) {
                    let last = chatDisplay.lastElementChild;
                    if (last && last.className === 'msg' && last.innerHTML.startsWith('<b>Ollama:</b>')) {
                        last.innerHTML = `<b>Ollama:</b> ${response}`;
                    } else {
                        appendMessage('Ollama', data.content);
                    }
                }
            }
            if (data.done) {
                conversation.push(['Ollama', response]);
                if (ttsToggle.checked) speakText(response);
                setStatus('Ready.');
                socket.off('chat_response', handler);
                done = true;
            }
        });
    } else {
        setStatus('Ready.');
    }
    whisperStreamActive = false;
    window.whisperStreamBtn.textContent = '🌀 Start Whisper Stream';
}); 