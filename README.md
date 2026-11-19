# ✋ SignBridge — Live Sign-Language Translator

> **Capstone v0 — first UI attempt.** A live sign-language translator designed as a *learning companion*: students use it to practice signing, watch the machine "read" their hands, and learn to communicate with Deaf & hard-of-hearing people — with recognition built to drop in when the model is ready.

---

## What this is

SignBridge is a zero-dependency web app (HTML + CSS + vanilla JS — **no build step, no install**). It ships with:

| Capability | Status |
|---|---|
| **Live Translate** — signing space + live transcript with per-word confidence | ✅ works today (simulated engine) |
| **Real hand tracking** — MediaPipe 21-point landmark skeleton on your webcam | ✅ works today (CDN, no model needed) |
| **Practice arena** — 26 ASL letters, minimal pairs, spaced review queue | ✅ works today |
| **Learn library** — 45+ common signs with teacher-written notes, etiquette guide | ✅ works today |
| **Trained-model recognition** (signs → words) | 🔌 plug-in point ready — see `docs/MODELS.md` |

## Why the UI looks like this (the teaching rationale)

The design is deliberate, from 10 years of teaching sign language:

1. **Confidence is visible.** Every recognized word carries a colored underline (green → amber → red). Learners watch the machine *hesitate* on hard signs — and the amber/red words unfold alternatives ("Did you mean…?") that mirror real ASL confusion pairs (A/S/T, U/V, M/N…). **The machine's uncertainty is a lesson, not a bug.**
2. **Error is the strongest moment.** In the Practice arena, a miss always returns the *minimal-pair explanation* — "S has the thumb wrapped OVER the fingers — check you're not doing T." That's how a teacher corrects, so that's how the app corrects.
3. **The four parameters are always on screen.** Handshape · orientation · location · movement — the phonological lens of ASL — appears on every practice target.
4. **Spaced review.** Letters you miss go on a review queue and return until mastered (persisted in `localStorage`).
5. **Mirror mode.** Learners sign into a mirrored feed, the way humans actually learn mirror-neural skills — seeing their own hands as the Deaf person opposite them does.
6. **Two-column learning arc.** Signing space (input) sits beside the transcript (output). Learners compare *what they signed* against *what was understood* — the feedback loop that turns practice into skill.

## Run it

**Demo mode (everything except the camera):**
```bash
# just double-click index.html — it works from file://
```

**Live mode (webcam — needs a secure context):**
```bash
# any static server works:
python -m http.server 8000        # then open http://localhost:8000
# or
npx serve .                       # or php -S localhost:8000
```

> Chrome blocks `getUserMedia` on `file://`. Use `http://localhost` for live hand tracking.

## Architecture

```
sign-bridge/
├── index.html          → Live Translate (main view)
├── practice.html       → Practice arena (letters / phrases)
├── learn.html          → Dictionary + communication guide
├── styles/
│   ├── main.css        → design tokens, components, themes
│   └── views.css       → per-view layouts, responsive
├── js/
│   ├── data/signs.js           → ASL dataset (letters, phrases, confusions, etiquette)
│   ├── engine/
│   │   ├── recognizer.js       → ★ the seam: UI talks to SB.Engine, nothing else
│   │   ├── simulated.js        → demo engine (realistic token stream, near-misses)
│   │   └── live.js             → MediaPipe Hands + landmark overlay + classifier plug-in
│   ├── ui/
│   │   ├── common.js           → settings/theme/toasts/speech/clipboard
│   │   └── transcript.js       → transcript bubbles + spotlight
│   └── views/
│       ├── translate.js        → translate page controller
│       ├── practice.js         → practice arena controller
│       ├── learn.js            → dictionary controller
│       └── settings.js         → settings drawer
└── docs/
    ├── MODELS.md       → model research + recommendation (read before ML work)
    └── ROADMAP.md      → future features
```

### The recognition seam (most important design decision)

```js
// recognizer.js — the ONLY module the UI touches.
// mode 'demo'  → SB.SimEngine streams realistic tokens.
// mode 'live'  → SB.LiveEngine tracks real hands; if a classifier
//                is attached, its output flows to the SAME transcript.
SB.LiveEngine.setClassifier(function (landmarks /* Float32Array(63) */) {
  // return { text, conf, alt? } — trained model goes here
});
```

**The UI, transcript, practice arena, and learn library are 100% engine-agnostic.** You can demo the whole product today, and the model work (docs/MODELS.md) drops in without touching a single view.

## Interactivity map

| Where | What |
|---|---|
| Translate | `1`–`9` sign quick phrases · **▶ Watch a live demo** streams a full session · **Spell it** fingerspells any word · low-confidence words show clickable alternates |
| Translate | **📷 Live** switches to real MediaPipe hand tracking; landmarks toggle; mirror toggle; hand-presence pulse |
| Practice | Letter keys sign letters · misses add to the review queue · progress ring + streak · minimal-pairs cheat sheet · phrase deck |
| Learn | Search + category filter · **Show me** streams any sign through the recognizer · 8-point etiquette guide |
| Global | Theme (dark/light/system) · voice output with rate · confidence threshold · mirror/landmark defaults · progress reset |

## Accessibility

- WCAG-minded contrast in both themes; strong focus rings; `aria-live` transcripts (screen readers announce signing sessions).
- `prefers-reduced-motion` fully honoured.
- No information conveyed by color alone — confidence words are also labeled on hover/focus, and alternates are buttons.

## Roadmap

See `docs/ROADMAP.md` — from "classifier plugs in" to sentence-level ASL, speech-to-text replies, and a video dictionary.

---

*Built for the capstone checkpoint: a working, presentable product with a real learning philosophy — and a clean path to the real model.*
