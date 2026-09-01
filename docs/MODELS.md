# SignBridge — Model Research & Recommendation

> What the ML half of this capstone should be. Read this before training anything — the UI already speaks the token contract your model will fill.

## 1. The constraint that decides everything

SignBridge runs **live, in a browser, on student laptops**. That rules out heavyweight video models (SlowFast, large ViTs) and pushes toward the approach that dominates 2025 research:

> **MediaPipe hand landmarks as input, a small classifier on top.** Landmark-only inputs reach competitive or state-of-the-art accuracy while cutting computational cost by orders of magnitude versus raw-RGB video models.

## 2. Recommended pipeline (capstone scope)

```
webcam → MediaPipe Hands (21 landmarks × 3 coords)
       → normalize (x/y to hand bbox, z relative to wrist)   ← ALREADY IMPLEMENTED in js/engine/live.js
       → classifier: LSTM / GRU / TCN (per-word signs)
       → token { text, conf, alt }                           ← the contract the UI renders
```

**Why LSTM/TCN over fancier options:**
- The proven real-time baseline — e.g. MediaPipe + LSTM pipelines report ~99%+ on isolated gestures, and MP-GestLSTM is a peer-reviewed 2025 reference (Tandfonline, 2025).
- Trains in minutes on a laptop with a self-collected dataset; exports to TF.js for in-browser inference, or serves via a tiny FastAPI/WebSocket socket if you'd rather keep Python.
- The confusion-matrix output feeds straight into the UI's existing teaching features (near-miss suggestions).

### Alternatives, if you want to push accuracy

| Approach | Reported | Notes |
|---|---|---|
| **MediaPipe + YOLOv7** (static letters) | 99.4% acc, 0.995 mAP on 2,000 images | Best raw accuracy for fingerspelling; needs a GPU to train, heavier to run (Inderscience IJBET, 2025) |
| **L2IC + MobileViT-XXS** (landmarks → image → ViT) | 97.98% acc / Macro-F1 | Excellent for letters on resource-limited devices — good in-browser candidate (DOAJ, 2025) |
| **MediaPipe + LSTM / TCN** | ~99% on isolated gestures | ← **recommended** — simplest end-to-end, real-time friendly (Tandfonline MP-GestLSTM, 2025) |
| **TSLFormer** (lightweight transformer on skeletal joints) | competitive on AUTSL (227 words) | Next step after LSTM if you reach word-level recognition (Hugging Face papers, 2025) |
| **H&HT + ViT** | SOTA among 32-frame models on WLASL2000 | Research-grade; overkill for capstone scope |

## 3. Datasets

| Dataset | Use | Notes |
|---|---|---|
| **WLASL** | word-level ASL | 2,000+ words; the standard benchmark |
| **ASLLVD** | ASL lexicon | richer per-sign data |
| **Self-collected** (recommended for your 26 letters + 45 phrases) | fingerspelling + your phrase set | 100–200 samples/sign via the same webcam pipeline the UI already has; record with the landmark overlay on and save `Float32Array(63)` vectors — the UI can even be the data-capture tool |

**Letter baseline to aim for:** 26-class fingerspelling with landmarks + LSTM/MLP routinely reaches 97–99% on a modest self-collected set.

## 4. The exact plug-in contract (already implemented)

`js/engine/live.js` computes, for every frame with a hand:

```
Float32Array(63) — [x0,y0,z0, x1,y1,z1, …x20,y20,z20]
  x,y ∈ [0,1]   (normalized to hand bounding box)
  z            (normalized relative to wrist; wrist.z = 0)
```

Your model returns one of:

```js
{ text: "help", conf: 0.94 }            // high-confidence word
{ text: "more", conf: 0.61, alt: ["please", "more?"] }  // low-confidence + alternatives
```

Wire it with **one line** — and the transcript, spotlight, practice arena, and alternates UI all start working with real recognition:

```js
SB.LiveEngine.setClassifier(function (feats) {
  return myModel.predict(feats);   // your TF.js / socket call
});
```

## 5. Evaluation (capstone-report ready)

- **Accuracy / F1** on a held-out split per class — then **report the confusion matrix as a feature**: the UI's teaching hints were built from exactly these documented confusions (A/S/T, U/V, M/N, G/Q, K/P…). Show the reviewers that *the product teaches the classes the model confuses*.
- **Latency**: target < 200 ms end-to-end on a mid-range laptop.
- **Robustness**: background, lighting, left/right handedness (mirror mode), one hand at a time in v1.

## 6. Sources

- Finger gesture recognition: MediaPipe + advanced YOLOv7 for deaf people — *Int. J. Biomedical Engineering & Technology*, 2025 ([Inderscience](https://www.inderscience.com/info/inarticle.php?artid=146402))
- MP-GestLSTM: real-time gesture detection using MediaPipe and LSTM — 2025 ([Tandfonline](https://www.tandfonline.com/doi/full/10.1080/21642583.2025.2587853))
- L2IC + MobileViT-XXS for BISINDO alphabet recognition — ([DOAJ](https://doaj.org/article/d22b63d4de6a4271a846103e031c1ab5))
- TSLFormer: lightweight transformer for SLR using skeletal landmarks — ([Hugging Face papers](https://huggingface.co/papers/2505.07890))
- Head-and-Hands Tunneling + ViT for WLASL2000 — ([IEEE](https://ieeexplore.ieee.org/document/11087542))
- Multimodal fusion (RGB CNN + MediaPipe landmarks), Thai SLR — ([IEEE](https://ieeexplore.ieee.org/document/10987852))
- Vision Mamba vs Swin vs ConvNeXt on MediaPipe landmarks — ([IEEE](https://ieeexplore.ieee.org/document/11375331))
