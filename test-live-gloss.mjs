/**
 * Puppeteer smoke: Live gloss classifier → CURRENT SIGN + transcript.
 * Uses fake camera + injected landmarks path via Engine._result and classify().
 */
import puppeteer from "puppeteer-core";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const CHROME =
  process.env.CHROME_PATH ||
  ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(
    (p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }
  );

const BASE = process.env.SB_URL || "http://127.0.0.1:4174/";

function makeOpenHandFeats() {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: 0.5, y: 0.55, z: 0 });
  lm[0] = { x: 0.5, y: 0.95, z: 0 };
  const tips = [
    [4, 0.15, 0.35],
    [8, 0.35, 0.12],
    [12, 0.5, 0.1],
    [16, 0.65, 0.12],
    [20, 0.8, 0.2],
  ];
  const mcps = [
    [2, 0.25, 0.55],
    [5, 0.35, 0.5],
    [9, 0.5, 0.48],
    [13, 0.65, 0.5],
    [17, 0.78, 0.55],
  ];
  for (const [i, x, y] of mcps) lm[i] = { x, y, z: 0 };
  for (const [i, x, y] of tips) lm[i] = { x, y, z: 0 };
  let minX = 1e9,
    maxX = -1e9,
    minY = 1e9,
    maxY = -1e9;
  for (const p of lm) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const feats = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    feats[i * 3] = (lm[i].x - minX) / span;
    feats[i * 3 + 1] = (lm[i].y - minY) / span;
    feats[i * 3 + 2] = (lm[i].z - lm[0].z) / span;
  }
  return Array.from(feats);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});

const page = await browser.newPage();
page.setDefaultTimeout(45000);
await page.goto(BASE + "?v=glosstest", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.SB && SB.HandshapeClassifier && SB.Engine);

const classifyResult = await page.evaluate((featsArr) => {
  const feats = new Float32Array(featsArr);
  const out = [];
  for (let i = 0; i < 5; i++) out.push(SB.HandshapeClassifier.classify(feats));
  return out;
}, makeOpenHandFeats());

console.log("classify samples:", JSON.stringify(classifyResult, null, 2));

const pipeline = await page.evaluate(async () => {
  /* Attach + fire Engine._result as Live would */
  const eng = SB.Engine.getLiveEngine();
  eng.setClassifier(SB.HandshapeClassifier.classify);
  eng._classifierKind = "handshape";

  /* Force mode live without camera for token path */
  const prev = SB.Engine.getMode;
  let mode = "live";
  SB.Engine.getMode = () => mode;

  const tok = { text: "Hello", conf: 0.88, glyph: "👋", source: "live" };
  /* Fire many times — must append Hello only once while pose held */
  for (let i = 0; i < 20; i++) {
    SB.Engine._result(tok);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 350));

  /* Same gloss again should still not duplicate */
  for (let i = 0; i < 10; i++) {
    SB.Engine._result(tok);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));

  /* Pose change → Yes should append once */
  const tokYes = { text: "Yes", conf: 0.9, glyph: "✊", source: "live" };
  for (let i = 0; i < 12; i++) {
    SB.Engine._result(tokYes);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 300));

  /* Hand leave unlocks; Hello can fire again */
  SB.Engine._hands(0);
  await new Promise((r) => setTimeout(r, 50));
  SB.Engine._hands(1);
  for (let i = 0; i < 12; i++) {
    SB.Engine._result(tok);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 300));

  const current = document.getElementById("txCurrentWord");
  const words = Array.from(document.querySelectorAll("#transcript .word")).map(
    (w) => (w.dataset.text || w.textContent).replace(/\s+/g, " ").trim()
  );
  const helloCount = words.filter((w) => /^hello$/i.test(w)).length;
  const yesCount = words.filter((w) => /^yes$/i.test(w)).length;
  const hasClassifier = eng.hasClassifier();
  return {
    hasClassifier,
    currentSign: current ? current.textContent.trim() : null,
    words,
    helloCount,
    yesCount,
  };
});

console.log("pipeline:", JSON.stringify(pipeline, null, 2));

const okClassify = classifyResult.some((t) => t && t.text);
const okCurrent =
  pipeline.currentSign &&
  pipeline.currentSign !== "—" &&
  /hello|hand|yes|peace/i.test(pipeline.currentSign);
const okOnce =
  pipeline.helloCount === 2 && /* once held + once after hand leave */
  pipeline.yesCount === 1;

await browser.close();

if (!okClassify) {
  console.error("FAIL: classifier did not return a gloss for open hand");
  process.exit(1);
}
if (!okCurrent) {
  console.error("FAIL: CURRENT SIGN did not update");
  process.exit(1);
}
if (!okOnce) {
  console.error(
    "FAIL: expected Hello×2 (hold+re-raise) and Yes×1, got",
    pipeline.helloCount,
    pipeline.yesCount,
    pipeline.words
  );
  process.exit(1);
}
console.log("PASS: one gloss per pose; re-fire only after hand leave / pose change");
process.exit(0);
