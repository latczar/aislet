"""A stand-in for Ollama on 127.0.0.1:11434, for running hub_attack_test.py where the real one isn't installed
(for example in WSL or on a Linux test machine). It answers the few calls the test makes, with made-up text.

    python3 pc/tests/fake_ollama.py      # leave it running, then start the test hub and run the test
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def reply(self, body: bytes, kind: str = "application/json") -> None:
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/api/version":
            return self.reply(b'{"version": "0.0.0-fake"}')
        if self.path == "/api/tags":
            return self.reply(json.dumps({"models": [{"name": "qwen3.5:9b"}, {"name": "nomic-embed-text:latest"}]}).encode())
        self.send_error(404)

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/chat":
            words = ["Hello", " from", " the fake Ollama."]
            lines = [json.dumps({"message": {"role": "assistant", "content": w}, "done": False}) for w in words]
            lines.append(json.dumps({"message": {"role": "assistant", "content": ""}, "done": True}))
            return self.reply(("\n".join(lines) + "\n").encode(), "application/x-ndjson")
        self.send_error(404)


if __name__ == "__main__":
    print("Fake Ollama on http://127.0.0.1:11434")
    ThreadingHTTPServer(("127.0.0.1", 11434), Fake).serve_forever()
