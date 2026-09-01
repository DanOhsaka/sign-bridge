# SignBridge — Roadmap

Every item below is deliberately **UI-ready**: the architecture (engine seam + token contract) was built so features drop in without redesign.

## v0 — this build (first UI attempt) ✅

- [x] Simulated recognition engine — full product demoable before any model exists
- [x] Real MediaPipe hand tracking (landmark overlay, mirror mode, hand-presence)
- [x] Confidence-visible transcript with alternates + manual confirmation
- [x] Practice arena: letters, 4-parameter teaching, minimal pairs, spaced review queue
- [x] Learn library: 45+ signs, etiquette guide, ASL facts
- [x] Settings: theme, voice/rate, threshold, toggles — all persisted
- [x] Accessibility: contrast, focus, aria-live, reduced motion

## v1 — real recognition (the model phase)

- [ ] Train 26-letter fingerspelling + 45-phrase classifier on self-collected MediaPipe data (`docs/MODELS.md`)
- [ ] `SB.LiveEngine.setClassifier(...)` — one line to go live
- [ ] Data-capture mode: record your own signs *inside the app* (the overlay is the capture tool)
- [ ] Confidence calibration so amber/red actually means "model unsure"

## v2 — words → sentences

- [ ] Word-level vocabulary (WLASL subset) via LSTM/TCN
- [ ] Sentence-level streaming: segmentation by hand-drop/movement pauses
- [ ] TSLFormer-style transformer if accuracy plateaus
- [ ] Continuous (non-isolated) signing

## v3 — conversation features

- [ ] **Speech-to-text reply**: hearing user types/speaks → rendered as text for the DHH user (real two-way bridge)
- [ ] Video dictionary: sign clips recorded by the team replace text descriptions
- [ ] Grammar-aware transcript (ASL word order ≠ English — show the gloss, not a naive translation)
- [ ] Practice ↔ live handoff: run the arena against real recognition

## v4 — scale & polish

- [ ] On-device TF.js inference (no server needed at demo time)
- [ ] Progress analytics (heatmaps of confusion per student — data-driven lesson plans)
- [ ] Spaced-repetition scheduler (SM-2) for the review queue
- [ ] Multi-language sign support (FSL, BSL, ISL — dataset-driven)
- [ ] PWA / offline packaging for classroom use

---

**The north star:** a student walks up, opens the app, practices five signs, walks to a Deaf classmate, and *tries*. The translator is the safety net; the learning is the point.
