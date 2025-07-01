const chatDisplay = document.getElementById('chat-display');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const recordBtn = document.getElementById('record-btn');
const saveBtn = document.getElementById('save-btn');
const clearBtn = document.getElementById('clear-btn');
const ttsToggle = document.getElementById('tts-toggle');
const statusDiv = document.getElementById('status');
const modeSelect = document.getElementById('transcribe-mode');
const themeToggle = document.getElementById('theme-toggle');
const micVisualizer = document.getElementById('mic-visualizer');

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

let micVizActive = false;
let micVizAudioContext, micVizSource, micVizAnalyser, micVizAnimationId;

function simpleMarkdown(text) {
    // Escape HTML first
    text = escapeHtml(text);
    // Code blocks: ```python ... ```
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => {
        return `<pre class="chat-code-block"><code>${code}</code></pre>`;
    });
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, (m, code) => {
        return `<code class="chat-inline-code">${code}</code>`;
    });
    // Bold: **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // Italic: *text*
    text = text.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    // Numbered lists: lines starting with 1. 2. etc.
    text = text.replace(/(?:^|\n)(\d+\. .+(?:\n\d+\. .+)*)/g, function(m, list) {
        const items = list.split(/\n(?=\d+\. )/).map(item => `<li>${item.replace(/^\d+\. /, '')}</li>`).join('');
        return `<ol>${items}</ol>`;
    });
    // Bullet lists: lines starting with -
    text = text.replace(/(?:^|\n)(- .+(?:\n- .+)*)/g, function(m, list) {
        const items = list.split(/\n(?=- )/).map(item => `<li>${item.replace(/^- /, '')}</li>`).join('');
        return `<ul>${items}</ul>`;
    });
    // Paragraphs
    text = text.replace(/\n{2,}/g, '</p><p>');
    text = '<p>' + text + '</p>';
    return text;
}

function escapeHtml(str) {
    return str.replace(/[&<>"]+/g, function(m) {
        return ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;'
        })[m];
    });
}

function appendMessage(sender, message, opts = {}) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'msg ' + (sender === 'You' ? 'user' : 'bot');
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = sender === 'You' ? '🧑' : '🤖';
    // Message text
    const textDiv = document.createElement('div');
    if (sender === 'Ollama') {
        textDiv.innerHTML = simpleMarkdown(message || '');
    } else {
        textDiv.innerHTML = `<b>${sender}:</b> ${message}`;
    }
    // Timestamp
    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = opts.timestamp || new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    if (sender === 'You') {
        msgDiv.appendChild(textDiv);
        msgDiv.appendChild(avatar);
    } else {
        msgDiv.appendChild(avatar);
        msgDiv.appendChild(textDiv);
    }
    msgDiv.appendChild(ts);
    chatDisplay.appendChild(msgDiv);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
}

function setStatus(msg) {
    statusDiv.textContent = msg;
}

function setTheme(dark) {
    if (dark) {
        document.body.classList.add('dark');
        themeToggle.textContent = '☀️';
    } else {
        document.body.classList.remove('dark');
        themeToggle.textContent = '🌙';
    }
    localStorage.setItem('theme', dark ? 'dark' : 'light');
}

themeToggle.onclick = () => {
    setTheme(!document.body.classList.contains('dark'));
};

// On load, apply saved theme
setTheme(localStorage.getItem('theme') === 'dark');

sendBtn.onclick = async () => {
    const prompt = textInput.value.trim();
    if (!prompt) return;
    textInput.value = '';
    appendMessage('You', prompt);
    setStatus('Ollama is responding...');
    showTypingIndicator();
    conversation.push(['You', prompt]);
    let response = '';
    let done = false;
    socket.emit('chat', { prompt });
    socket.on('chat_response', function handler(data) {
        if (data.error) {
            hideTypingIndicator();
            appendMessage('Ollama', '[Error: ' + data.error + ']');
            setStatus('Ready.');
            socket.off('chat_response', handler);
            return;
        }
        if (data.content) {
            response += data.content;
        }
        if (data.done) {
            hideTypingIndicator();
            appendMessage('Ollama', response);
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

function showMicVisualizer(stream) {
    micVisualizer.style.display = '';
    micVizActive = true;
    micVizAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    micVizSource = micVizAudioContext.createMediaStreamSource(stream);
    micVizAnalyser = micVizAudioContext.createAnalyser();
    micVizAnalyser.fftSize = 512;
    micVizSource.connect(micVizAnalyser);
    const canvas = micVisualizer;
    const ctx = canvas.getContext('2d');
    function draw() {
        if (!micVizActive) return;
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);
        const data = new Uint8Array(micVizAnalyser.fftSize);
        micVizAnalyser.getByteTimeDomainData(data);
        ctx.lineWidth = 2;
        ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--primary') || '#2563eb';
        ctx.beginPath();
        const sliceWidth = width / data.length;
        let x = 0;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0;
            const y = (v * height) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        micVizAnimationId = requestAnimationFrame(draw);
    }
    draw();
}

function hideMicVisualizer() {
    micVisualizer.style.display = 'none';
    micVizActive = false;
    if (micVizAudioContext) {
        micVizAudioContext.close();
        micVizAudioContext = null;
    }
    if (micVizAnimationId) cancelAnimationFrame(micVizAnimationId);
}

recordBtn.onclick = async () => {
    if (isRecording) {
        mediaRecorder.stop();
        setStatus('Processing audio...');
        recordBtn.textContent = '🎤 Record';
        isRecording = false;
        hideMicVisualizer();
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
        showMicVisualizer(stream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            hideMicVisualizer();
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
                            // Stream update: update the last Ollama bubble, or create if not present
                            let last = chatDisplay.lastElementChild;
                            if (!last || !last.classList.contains('bot')) {
                                appendMessage('Ollama', response);
                            } else {
                                // Update only the message text, keep avatar and timestamp
                                let textDiv = last.querySelector('div:not(.avatar)');
                                if (textDiv) textDiv.innerHTML = simpleMarkdown(response);
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
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        showMicVisualizer(stream);
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
                            // Stream update: update the last Ollama bubble, or create if not present
                            let last = chatDisplay.lastElementChild;
                            if (!last || !last.classList.contains('bot')) {
                                appendMessage('Ollama', response);
                            } else {
                                // Update only the message text, keep avatar and timestamp
                                let textDiv = last.querySelector('div:not(.avatar)');
                                if (textDiv) textDiv.innerHTML = simpleMarkdown(response);
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
            hideMicVisualizer();
            stream.getTracks().forEach(track => track.stop());
        };
        recognition.onerror = (e) => {
            setStatus('Web Speech error: ' + e.error);
            recognition.stop();
            hideMicVisualizer();
            stream.getTracks().forEach(track => track.stop());
        };
        recognition.start();
    });
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
        hideMicVisualizer();
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
        showMicVisualizer(stream);
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
            hideMicVisualizer();
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
                // Stream update: update the last Ollama bubble, or create if not present
                let last = chatDisplay.lastElementChild;
                if (!last || !last.classList.contains('bot')) {
                    appendMessage('Ollama', response);
                } else {
                    // Update only the message text, keep avatar and timestamp
                    let textDiv = last.querySelector('div:not(.avatar)');
                    if (textDiv) textDiv.innerHTML = simpleMarkdown(response);
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

function showTypingIndicator() {
    if (document.getElementById('typing-indicator')) return;
    const typingDiv = document.createElement('div');
    typingDiv.className = 'typing-indicator';
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = '<span class="avatar">🤖</span>' +
        '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    chatDisplay.appendChild(typingDiv);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
}

function hideTypingIndicator() {
    const typingDiv = document.getElementById('typing-indicator');
    if (typingDiv) typingDiv.remove();
} 