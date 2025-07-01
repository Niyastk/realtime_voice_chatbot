import requests
import json

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "mistral:latest"  # Change to any model you have installed

def stream_chat(prompt):
    headers = {"Content-Type": "application/json"}
    data = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "stream": True
    }

    # Make the POST request with stream=True
    with requests.post(OLLAMA_URL, headers=headers, json=data, stream=True) as response:
        for line in response.iter_lines():
            if line:
                # Ollama streams JSON objects per line
                chunk = json.loads(line.decode('utf-8'))
                content = chunk.get("message", {}).get("content", "")
                print(content, end="", flush=True)
    print()  # Newline after the response

if __name__ == "__main__":
    user_prompt = input("You: ")
    print("Ollama:", end=" ", flush=True)
    stream_chat(user_prompt)
