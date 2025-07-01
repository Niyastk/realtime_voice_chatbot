const chatDisplay = document.getElementById('chat-display');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const recordBtn = document.getElementById('record-btn');
const saveBtn = document.getElementById('save-btn');
const clearBtn = document.getElementById('clear-btn');
const ttsToggle = document.getElementById('tts-toggle');
const statusDiv = document.getElementById('status');

let conversation = [];
let isRecording = false;
let mediaRecorder;
let audioChunks = [];

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
    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        if (data.response) {
            appendMessage('Ollama', data.response);
            conversation.push(['Ollama', data.response]);
            if (ttsToggle.checked) speakText(data.response);
        } else {
            appendMessage('Ollama', '[Error: ' + (data.error || 'Unknown error') + ']');
        }
    } catch (e) {
        appendMessage('Ollama', '[Error: ' + e + ']');
    }
    setStatus('Ready.');
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
                    // Send to chat
                    const chatRes = await fetch('/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: data.text })
                    });
                    const chatData = await chatRes.json();
                    if (chatData.response) {
                        appendMessage('Ollama', chatData.response);
                        conversation.push(['Ollama', chatData.response]);
                        if (ttsToggle.checked) speakText(chatData.response);
                    } else {
                        appendMessage('Ollama', '[Error: ' + (chatData.error || 'Unknown error') + ']');
                    }
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