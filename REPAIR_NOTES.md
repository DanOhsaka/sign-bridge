# SignBridge repair snapshot

This is a clean source snapshot built from the post-merge ZIP supplied on 2026-11-12.
It intentionally excludes `.git`, `node_modules`, `.venv`, `venv`, `.cursor`, Python
cache directories, and the local `server/.env` file (which contains a development JWT secret). The original project and both supplied ZIPs were not modified.

## Changes made

1. Aligned both Node prediction proxies (`api/_lib/predictRoutes.js` and
   `server/routes/predict.js`) to the existing 60-frame contract used by
   `js/engine/lstm-live-test.js`, `ml/api.py`, and `ml/inference.py`.
2. Corrected the stale 30-frame documentation/comment in the LSTM test and ML README.
3. Removed the old `SB.DataCapture` recording panel from desktop and mobile Translate
   markup, removed its dead controller/overlay hooks, and stopped loading the legacy
   `capture.js` script. The legacy file remains in the tree but is unreferenced. The
   current `TrainingRecorder` remains loaded and called from `js/engine/live.js`; do not
   remove it.
4. Updated the shared Translate controller and transcript renderer to the newer
   `origin/main` transcript UX (candidate confirmation, current-sign workspace,
   pagehide camera cleanup, and translated read-aloud support). Kept the optional
   mobile captions attachment.
5. Updated desktop and mobile transcript markup to the same workspace structure and
   added the required workspace styles.

## Merge / model preservation notes

- The 60-frame LSTM model contract is retained. No model, labels, or training-data
  files were changed.
- The November 9 LSTM training-system work is newer than the archived October 28
  `origin/main` snapshot. This repair does not replace the Pose Lite/LSTM engine with
  the older Holistic engine.
- `handStability.js` and `handshapeClassifier.js` remain in the source tree but are
  not loaded by the Pose Lite live engine. The classifier file is intentionally a
  disabled stub; do not treat it as a trained recognition model.
- The meeting ideas to remove Demo/Quick Phrases or combine Learn and Practice were
  not implemented because the notes describe them as proposed UI changes, not final
  requirements.
- The mobile Learn and Practice pages were not structurally redesigned.

## Validation

Static validation performed after repair:
- JavaScript syntax checks (`node --check`) for project `.js` and `.mjs` files.
- Local script/stylesheet reference checks for root and mobile HTML pages.
- Confirmed both prediction proxies validate 60 frames.
- Confirmed the active `TrainingRecorder` hook remains in `live.js`.
- Added `npm run test:predict-proxy` to guard the 60-frame API contract; the test passed.
- Confirmed the legacy capture panel, controller hooks, and `capture.js` includes are absent; the legacy file is retained but unreferenced.

Camera permission, real device tracking, actual model inference, and end-to-end
production/Vercel behavior still require runtime testing with the team's Python model
environment and a physical phone.
