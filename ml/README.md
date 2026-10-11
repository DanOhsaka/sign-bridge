# SignBridge LSTM inference integration

The model is independent of FastAPI: `ml/inference.py` exposes `SignBridgeLSTM.predict(frames)` for any Python caller. `ml/api.py` is an **optional** HTTP adapter for local testing or a Node.js backend. No model training is needed to run inference.

## Setup (from repository root)

```powershell
python -m pip install -r ml/requirements.txt
python -m uvicorn ml.api:app --host 127.0.0.1 --port 8001
```

Open `http://127.0.0.1:8001/health` for status and `http://127.0.0.1:8001/docs` for API documentation.

For the frontend, open a **separate terminal** in the `sign-bridge` directory and run:

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Then visit **`http://127.0.0.1:8000/`** (not `/sign-bridge/` when serving from this directory). Select **Live** to enable the temporary `lstm-live-test.js` adapter. The browser sends normalized 30-frame sequences directly to the local API and publishes the `signbridge:lstm-prediction` event consumed by the Translate view.

## Input and output contract

`POST /predict` expects `{ "frames": [ ...30 frames... ] }`. Each frame must match the `hands-arms-v2` recording format produced by `TrainingRecorder.createReadableFrame`: `leftHand`, `rightHand`, `pose` with shoulder-centered-v1 normalization. `ml/dataset.py` converts each frame to **146** ordered features. Do not change the normalization or feature ordering without retraining. Missing hands are supported.

Response: `{ "prediction": "HELLO", "confidence": 0.99, "probabilities": { "HELLO": 0.99, "MY": 0.008, "NAME": 0.002 } }` (example only). Current model labels: HELLO, MY, NAME. There is no UNKNOWN/NO_SIGN class; confidence is not calibrated accuracy.

## Node.js integration

For a Node.js backend on the same host, call the optional Python service using Node 18+ `fetch`:

```js
async function predictSign(frames) {
  const response = await fetch('http://127.0.0.1:8001/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frames })
  });
  if (!response.ok) throw new Error(`Prediction HTTP ${response.status}`);
  return response.json();
}
```

For production, have the browser call the Node.js backend rather than the Python API directly; the frontend's temporary adapter is for local testing. When Node and Python run on different hosts/containers, configure the private service address appropriately. Do not expose the model API publicly without access controls.

## GitHub

Commit source files, `ml/models/labels.txt`, and the model (`.keras`, if within repository limits). Do not commit `.venv`, `node_modules`, `.git` copies, caches, or secrets. Training and test recordings are optional and may contain personal motion data; review them before sharing.
