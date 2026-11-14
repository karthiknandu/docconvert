"""DocConvert laptop helper.

Runs on your personal laptop. It lets the DocConvert app on your phone (or in the laptop's browser)
  * share what the app has learned (corrections, dictionary, layouts) between devices, and
  * send hard pages to a free vision AI model running locally in Ollama (nothing leaves your network).

Only Python's standard library is used – no pip installs needed.
Start it with start_helper.bat (Windows) or:  python docconvert_helper.py
"""
import base64
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
PORT = int(os.environ.get("DOCCONVERT_PORT", "8787"))
HOST = os.environ.get("DOCCONVERT_HOST", "127.0.0.1")
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
DATA_DIR = os.path.join(os.path.expanduser("~"), "DocConvertHelper")
os.makedirs(DATA_DIR, exist_ok=True)
LEARN_FILE = os.path.join(DATA_DIR, "learning.json")
CONF_FILE = os.path.join(DATA_DIR, "config.json")
ALLOWED_ORIGINS = {"https://karthiknandu.github.io", "http://localhost:8765", "http://127.0.0.1:8765"}
# preferred vision models, best first; the first one that is installed in Ollama is used
PREFERRED_MODELS = ["qwen3-vl:8b-instruct", "qwen3-vl:4b-instruct", "qwen3-vl:8b", "qwen3-vl:4b", "qwen3-vl:2b-instruct",
                    "qwen3-vl:2b", "qwen2.5vl:7b", "qwen2.5vl:3b", "minicpm-v", "llama3.2-vision"]

PROMPT = (
    "Transcribe this document page exactly as written. Output Markdown only:\n"
    "- '# ' for the main title, '## ' for section headings\n"
    "- '**Label:** value' for form fields and labels\n"
    "- '- ' for bullet points, '1. ' for numbered items\n"
    "- Markdown tables (| a | b |) for tables, one table row per line\n"
    "Keep the original language and spelling. Do not translate, summarise, explain or add anything that is not on the page. "
    "Leave out logos, stamps, signatures and page decorations. "
    "Write handwriting only if it is clearly legible, as [handwritten: ...]."
)

_lock = threading.Lock()


def load_conf():
    try:
        with open(CONF_FILE, encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        c = {}
    if not c.get("key"):
        c["key"] = secrets.token_urlsafe(9)
        with open(CONF_FILE, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=1)
    return c


CONF = load_conf()


def ollama(path, payload=None, timeout=600):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def installed_models():
    try:
        return [m["name"] for m in ollama("/api/tags", timeout=5).get("models", [])]
    except Exception:
        return None


def pick_model():
    want = CONF.get("model") or os.environ.get("DOCCONVERT_MODEL")
    have = installed_models()
    if have is None:
        return None, "Ollama is not running"
    if want and want in have:
        return want, None
    for m in PREFERRED_MODELS:
        if m in have or (":" not in m and any(h.startswith(m + ":") for h in have)):
            return (m if m in have else next(h for h in have if h.startswith(m + ":"))), None
    return None, "no vision model installed (run: ollama pull qwen3-vl:4b-instruct)"


def read_page(image_b64, hint=""):
    model, err = pick_model()
    if not model:
        raise RuntimeError(err)
    prompt = PROMPT + (("\nThe page is probably in: " + hint) if hint else "")
    t = time.time()
    res = ollama("/api/chat", {
        "model": model, "stream": False, "think": False,
        "options": {"temperature": 0, "num_ctx": 8192},
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
    })
    text = (res.get("message") or {}).get("content", "")
    # some models wrap the answer in a code fence
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    log(f"read a page with {model} in {time.time() - t:.0f}s")
    return text.strip(), model


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "DocConvertHelper/" + VERSION

    def log_message(self, fmt, *args):  # quieter console
        pass

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-DocConvert-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body) if ctype == "application/json" else body).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if "json" in ctype or "text" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        if self.headers.get("X-DocConvert-Key", "") != CONF["key"]:
            self.reply(403, {"error": "wrong key"})
            return False
        return True

    def body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n > 200 * 1024 * 1024:
            raise ValueError("too large")
        return self.rfile.read(n)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/status"):
            model, err = pick_model()
            html = f"""<!doctype html><meta name=viewport content='width=device-width'><title>DocConvert helper</title>
<body style='font-family:system-ui;max-width:640px;margin:30px auto;padding:0 16px'>
<h2>DocConvert laptop helper {VERSION}</h2>
<p>Status: <b>running</b></p>
<p>Vision AI: <b>{model or 'not ready – ' + err}</b></p>
<p>Learning file: {LEARN_FILE} ({os.path.getsize(LEARN_FILE) // 1024 if os.path.exists(LEARN_FILE) else 0} KB)</p>
<p>Enter this helper's address and key in the app (🧠 → Laptop helper). The key is shown in the helper window.</p></body>"""
            return self.reply(200, html, "text/html")
        if self.path == "/ping":
            if not self.authed():
                return
            model, err = pick_model()
            return self.reply(200, {"ok": True, "version": VERSION, "model": model, "modelError": err})
        if self.path == "/learning":
            if not self.authed():
                return
            with _lock:
                data = open(LEARN_FILE, "rb").read() if os.path.exists(LEARN_FILE) else b"null"
            return self.reply(200, data)
        self.reply(404, {"error": "not found"})

    def do_PUT(self):
        if self.path != "/learning":
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return
        try:
            data = self.body()
            obj = json.loads(data.decode("utf-8"))
            if not isinstance(obj, dict) or obj.get("v") != 1:
                return self.reply(400, {"error": "not a DocConvert learning file"})
        except Exception as e:
            return self.reply(400, {"error": str(e)})
        with _lock:
            tmp = LEARN_FILE + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, LEARN_FILE)
        log(f"learning updated ({len(data) // 1024} KB)")
        self.reply(200, {"ok": True})

    def do_POST(self):
        if self.path != "/vision":
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return
        try:
            req = json.loads(self.body().decode("utf-8"))
            base64.b64decode(req["image"][:100] + "==", validate=False)
            text, model = read_page(req["image"], req.get("hint", ""))
            self.reply(200, {"markdown": text, "model": model})
        except urllib.error.URLError as e:
            self.reply(503, {"error": "Ollama not reachable: " + str(e)})
        except Exception as e:
            self.reply(500, {"error": str(e)})


def main():
    model, err = pick_model()
    print("=" * 60)
    print(" DocConvert laptop helper", VERSION)
    print(" Address on this laptop :", f"http://{HOST}:{PORT}")
    print(" Key for the app        :", CONF["key"])
    print(" Vision AI              :", model or ("NOT READY – " + err))
    print(" Data folder            :", DATA_DIR)
    print(" Keep this window open while you use the app. Ctrl+C to stop.")
    print("=" * 60, flush=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--key":
        print(CONF["key"])
    else:
        main()
