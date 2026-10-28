/* POST /api/translate — proxy free MyMemory for CORS-safe TTS translation.
   Body: { q, source?, target? }  →  { translatedText }
   Normalizes ALL-CAPS ASL glosses and applies a local glossary so
   Hello/HELLO → Hola / こんにちは. Never returns English as a translation.
   No API keys. Subject to MyMemory public rate limits. */

var GLOSSARY = {
  hello: {
    es: "Hola", fr: "Bonjour", de: "Hallo", it: "Ciao", pt: "Olá",
    zh: "你好", ja: "こんにちは", ko: "안녕하세요", hi: "नमस्ते", ar: "مرحبا"
  },
  hi: {
    es: "Hola", fr: "Salut", de: "Hi", it: "Ciao", pt: "Oi",
    zh: "嗨", ja: "こんにちは", ko: "안녕", hi: "नमस्ते", ar: "مرحبا"
  },
  my: {
    es: "mi", fr: "mon", de: "mein", it: "mio", pt: "meu",
    zh: "我的", ja: "私の", ko: "나의", hi: "मेरा", ar: "لي"
  },
  name: {
    es: "nombre", fr: "nom", de: "Name", it: "nome", pt: "nome",
    zh: "名字", ja: "名前", ko: "이름", hi: "नाम", ar: "اسم"
  },
  yes: {
    es: "Sí", fr: "Oui", de: "Ja", it: "Sì", pt: "Sim",
    zh: "是", ja: "はい", ko: "네", hi: "हाँ", ar: "نعم"
  },
  no: {
    es: "No", fr: "Non", de: "Nein", it: "No", pt: "Não",
    zh: "不", ja: "いいえ", ko: "아니요", hi: "नहीं", ar: "لا"
  },
  thanks: {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  thank: {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  please: {
    es: "Por favor", fr: "S'il vous plaît", de: "Bitte", it: "Per favore",
    pt: "Por favor", zh: "请", ja: "お願いします", ko: "부탁합니다",
    hi: "कृपया", ar: "من فضلك"
  },
  goodbye: {
    es: "Adiós", fr: "Au revoir", de: "Tschüss", it: "Arrivederci",
    pt: "Adeus", zh: "再见", ja: "さようなら", ko: "안녕히 가세요",
    hi: "अलविदा", ar: "مع السلامة"
  },
  "thank you": {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  "my name": {
    es: "Me llamo", fr: "Je m'appelle", de: "Ich heiße", it: "Mi chiamo",
    pt: "Meu nome é", zh: "我叫", ja: "私の名前は", ko: "제 이름은",
    hi: "मेरा नाम", ar: "اسمي"
  },
  "hello my name": {
    es: "Hola, me llamo", fr: "Bonjour, je m'appelle", de: "Hallo, ich heiße",
    it: "Ciao, mi chiamo", pt: "Olá, meu nome é", zh: "你好，我叫",
    ja: "こんにちは、私の名前は", ko: "안녕하세요, 제 이름은",
    hi: "नमस्ते, मेरा नाम", ar: "مرحبا، اسمي"
  }
};

function normalizeForTranslate(text) {
  var s = String(text || "").replace(/\s+/g, " ").trim();
  var letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 2 && letters === letters.toUpperCase()) {
    return s.toLowerCase().replace(/(^|\s)([a-z])/g, function (_, a, b) {
      return a + b.toUpperCase();
    });
  }
  return s;
}

function glossaryLookup(text, target) {
  var key = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  var row = GLOSSARY[key];
  if (row && row[target]) return row[target];
  var parts = key.split(" ");
  if (parts.length < 2) return null;
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var r = GLOSSARY[parts[i]];
    if (!r || !r[target]) return null;
    out.push(r[target]);
  }
  return out.join(" ");
}

function looksUntranslated(source, translated, target) {
  var out = String(translated || "").trim();
  if (!out || /MYMEMORY WARNING/i.test(out)) return true;
  if (/^testvalue$/i.test(out)) return true;
  if (out.toLowerCase() === String(source || "").trim().toLowerCase()) return true;
  if (target === "ja" || target === "zh" || target === "ko" || target === "ar" || target === "hi") {
    var srcLetters = String(source || "").replace(/[^A-Za-z]/g, "");
    if (srcLetters && !/[^\u0000-\u007F]/.test(out)) return true;
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    var body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    var q = String(body.q || "").replace(/\s+/g, " ").trim().slice(0, 450);
    var source = String(body.source || "en").split("-")[0].toLowerCase();
    var target = String(body.target || "en").split("-")[0].toLowerCase();
    if (!q) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing q" }));
    }
    if (source === target) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ translatedText: q }));
    }

    var normalized = normalizeForTranslate(q);
    var gloss = glossaryLookup(normalized, target) || glossaryLookup(q, target);
    if (gloss) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ translatedText: gloss }));
    }

    var query = normalized || q;
    var url =
      "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(query) +
      "&langpair=" +
      encodeURIComponent(source + "|" + target);
    var upstream = await fetch(url);
    var data = await upstream.json();
    var out = data && data.responseData && data.responseData.translatedText;
    if (!out || looksUntranslated(q, out, target) || looksUntranslated(query, out, target)) {
      res.statusCode = 502;
      return res.end(JSON.stringify({
        error: "Upstream translate failed",
        detail: data && data.responseDetails
      }));
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ translatedText: String(out) }));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err && err.message ? err.message : "translate error" }));
  }
};
