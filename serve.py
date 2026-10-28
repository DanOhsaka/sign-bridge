#!/usr/bin/env python3
"""No-cache static server for SignBridge local preview.

Also proxies /api/predict → Python LSTM on 127.0.0.1:9001 so Live
can POST same-origin without the Node backend.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "4173"))
LSTM_URL = os.environ.get("LSTM_API_URL", "http://127.0.0.1:9001/predict")
LSTM_HEALTH = os.environ.get(
    "LSTM_HEALTH_URL", "http://127.0.0.1:9001/health"
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, max-age=0",
        )
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self):
        if self.path.split("?", 1)[0] in (
            "/api/predict",
            "/api/health",
            "/api/translate",
        ):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._proxy_get(LSTM_HEALTH)
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/predict":
            self._proxy_predict()
            return
        if path == "/api/translate":
            self._proxy_translate()
            return
        self.send_error(404)

    def _proxy_get(self, url):
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header(
                    "Content-Type",
                    resp.headers.get("Content-Type", "application/json"),
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read() or b'{"message":"upstream error"}'
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:
            payload = json.dumps({
                "message": "Could not reach the sign model. "
                           "Start the Python API on port 9001.",
                "error": str(err),
            }).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def _proxy_predict(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            payload = b'{"message":"Invalid JSON body."}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        frames = data.get("frames") if isinstance(data, dict) else None
        if not isinstance(frames, list) or len(frames) != 30:
            payload = b'{"message":"Expected exactly 30 frames."}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        req = urllib.request.Request(
            LSTM_URL,
            data=raw,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header(
                    "Content-Type",
                    resp.headers.get("Content-Type", "application/json"),
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read() or b'{"message":"The sign model rejected this sequence."}'
            status = err.code if 400 <= err.code < 600 else 502
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:
            payload = json.dumps({
                "message": "Could not reach the sign model. "
                           "Start the Python API on port 9001.",
                "error": str(err),
            }).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)


    def _proxy_translate(self):
        """Same-origin MyMemory proxy for TTS (CORS-safe).

        Normalizes ALL-CAPS ASL glosses (HELLO→Hello) and applies a small
        glossary so Hello/HELLO reliably become Hola / こんにちは / etc.
        Never returns the English source as a "translation".
        """
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            payload = b'{"error":"Invalid JSON body."}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        q = " ".join(str((data or {}).get("q") or "").split())[:450]
        source = str((data or {}).get("source") or "en").split("-")[0].lower()
        target = str((data or {}).get("target") or "en").split("-")[0].lower()
        if not q:
            payload = b'{"error":"Missing q"}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if source == target:
            payload = json.dumps({"translatedText": q}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        glossary = {
            "hello": {
                "es": "Hola", "fr": "Bonjour", "de": "Hallo", "it": "Ciao",
                "pt": "Olá", "zh": "你好", "ja": "こんにちは", "ko": "안녕하세요",
                "hi": "नमस्ते", "ar": "مرحبا",
            },
            "hi": {
                "es": "Hola", "fr": "Salut", "de": "Hi", "it": "Ciao",
                "pt": "Oi", "zh": "嗨", "ja": "こんにちは", "ko": "안녕",
                "hi": "नमस्ते", "ar": "مرحبا",
            },
            "my": {
                "es": "mi", "fr": "mon", "de": "mein", "it": "mio",
                "pt": "meu", "zh": "我的", "ja": "私の", "ko": "나의",
                "hi": "मेरा", "ar": "لي",
            },
            "name": {
                "es": "nombre", "fr": "nom", "de": "Name", "it": "nome",
                "pt": "nome", "zh": "名字", "ja": "名前", "ko": "이름",
                "hi": "नाम", "ar": "اسم",
            },
            "yes": {
                "es": "Sí", "fr": "Oui", "de": "Ja", "it": "Sì",
                "pt": "Sim", "zh": "是", "ja": "はい", "ko": "네",
                "hi": "हाँ", "ar": "نعم",
            },
            "no": {
                "es": "No", "fr": "Non", "de": "Nein", "it": "No",
                "pt": "Não", "zh": "不", "ja": "いいえ", "ko": "아니요",
                "hi": "नहीं", "ar": "لا",
            },
            "thanks": {
                "es": "Gracias", "fr": "Merci", "de": "Danke", "it": "Grazie",
                "pt": "Obrigado", "zh": "谢谢", "ja": "ありがとう",
                "ko": "감사합니다", "hi": "धन्यवाद", "ar": "شكرا",
            },
            "thank": {
                "es": "Gracias", "fr": "Merci", "de": "Danke", "it": "Grazie",
                "pt": "Obrigado", "zh": "谢谢", "ja": "ありがとう",
                "ko": "감사합니다", "hi": "धन्यवाद", "ar": "شكرا",
            },
            "please": {
                "es": "Por favor", "fr": "S'il vous plaît", "de": "Bitte",
                "it": "Per favore", "pt": "Por favor", "zh": "请",
                "ja": "お願いします", "ko": "부탁합니다", "hi": "कृपया",
                "ar": "من فضلك",
            },
            "goodbye": {
                "es": "Adiós", "fr": "Au revoir", "de": "Tschüss",
                "it": "Arrivederci", "pt": "Adeus", "zh": "再见",
                "ja": "さようなら", "ko": "안녕히 가세요", "hi": "अलविदा",
                "ar": "مع السلامة",
            },
            "thank you": {
                "es": "Gracias", "fr": "Merci", "de": "Danke", "it": "Grazie",
                "pt": "Obrigado", "zh": "谢谢", "ja": "ありがとう",
                "ko": "감사합니다", "hi": "धन्यवाद", "ar": "شكرا",
            },
            "my name": {
                "es": "Me llamo", "fr": "Je m'appelle", "de": "Ich heiße",
                "it": "Mi chiamo", "pt": "Meu nome é", "zh": "我叫",
                "ja": "私の名前は", "ko": "제 이름은", "hi": "मेरा नाम",
                "ar": "اسمي",
            },
            "hello my name": {
                "es": "Hola, me llamo", "fr": "Bonjour, je m'appelle",
                "de": "Hallo, ich heiße", "it": "Ciao, mi chiamo",
                "pt": "Olá, meu nome é", "zh": "你好，我叫",
                "ja": "こんにちは、私の名前は", "ko": "안녕하세요, 제 이름은",
                "hi": "नमस्ते, मेरा नाम", "ar": "مرحبا، اسمي",
            },
        }

        def normalize(text):
            s = " ".join(str(text or "").split())
            letters = "".join(ch for ch in s if ch.isalpha())
            if len(letters) >= 2 and letters == letters.upper():
                return " ".join(
                    w[:1].upper() + w[1:].lower() if w else w
                    for w in s.lower().split(" ")
                )
            return s

        def glossary_lookup(text):
            key = " ".join(str(text or "").split()).lower()
            row = glossary.get(key)
            if row and row.get(target):
                return row[target]
            parts = key.split(" ")
            if len(parts) < 2:
                return None
            out = []
            for part in parts:
                r = glossary.get(part)
                if not r or not r.get(target):
                    return None
                out.append(r[target])
            return " ".join(out)

        def looks_untranslated(source_text, translated):
            out = str(translated or "").strip()
            if not out or "MYMEMORY WARNING" in out.upper():
                return True
            if out.lower() == "testvalue":
                return True
            if out.lower() == str(source_text or "").strip().lower():
                return True
            if target in ("ja", "zh", "ko", "ar", "hi"):
                src_letters = "".join(
                    ch for ch in str(source_text or "") if ("A" <= ch <= "Z") or ("a" <= ch <= "z")
                )
                if src_letters and all(ord(ch) < 128 for ch in out):
                    return True
            return False

        normalized = normalize(q)
        gloss = glossary_lookup(normalized) or glossary_lookup(q)
        if gloss:
            payload = json.dumps({"translatedText": gloss}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        query = normalized or q
        url = (
            "https://api.mymemory.translated.net/get?q="
            + urllib.request.quote(query)
            + "&langpair="
            + urllib.request.quote(source + "|" + target)
        )
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                upstream = json.loads(resp.read().decode("utf-8") or "{}")
            out = (
                upstream.get("responseData") or {}
            ).get("translatedText")
            if not out or looks_untranslated(q, out) or looks_untranslated(query, out):
                payload = json.dumps({
                    "error": "Upstream translate failed",
                    "detail": upstream.get("responseDetails"),
                }).encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            payload = json.dumps({"translatedText": str(out)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as err:
            payload = json.dumps({
                "error": str(err) or "translate error",
            }).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(
        "Serving %s on http://127.0.0.1:%s/ "
        "(no-cache, /api/predict→9001, /api/translate)"
        % (ROOT, PORT),
        flush=True,
    )
    httpd.serve_forever()
