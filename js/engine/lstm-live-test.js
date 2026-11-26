(function () {
    "use strict";

    // Same-origin proxy. The server forwards to the Python model.
    const API_URL = "/api/predict";
    // The model input stays 60 frames. Those frames are resampled from a
    // shorter live window so a sign does not have to last for 60 detections.
    const SEQUENCE_LENGTH = 60;
    const WINDOW_MS = 1500;
    const MIN_SOURCE_FRAMES = 6;
    // Classify the latest window again after this many new detections.
    const STRIDE = 8;
    // One agreeing window is not enough; the next stride must match
    // before the transcript changes.
    const STABLE_COUNT = 2;

    const MIN_CONFIDENCE = 0.80;

    let active = false;
    let sending = false;
    let session = 0;
    let frames = [];
    let framesSinceSend = 0;
    let lastSkipLog = 0;
    let pendingLabel = null;
    let pendingCount = 0;
    let frameTimes = [];
    let lastRateLog = 0;

    function resetSequence() {
        frames = [];
        frameTimes = [];
        framesSinceSend = 0;
        pendingLabel = null;
        pendingCount = 0;
        sending = false;
    }

    function windowSpanMs() {
        if (frameTimes.length < 2) return 0;
        return frameTimes[frameTimes.length - 1] - frameTimes[0];
    }

    function signFramesPerSecond() {
        const span = windowSpanMs();
        if (span <= 0) return 0;
        return ((frameTimes.length - 1) * 1000) / span;
    }

    function reportRate() {
        const now = performance.now();
        if (now - lastRateLog < 1000) return;
        lastRateLog = now;

        let camera = "";
        const engine = window.SB &&
            SB.Engine &&
            SB.Engine.getLiveEngine &&
            SB.Engine.getLiveEngine();
        const perf = engine && engine.getPerfStats && engine.getPerfStats();
        if (perf) {
            camera =
                " Camera " + perf.camFps.toFixed(0) +
                "/s, hand detect " + perf.inferFps.toFixed(0) +
                "/s (" + perf.inferMs.toFixed(0) + "ms), dropped " +
                perf.dropped + ".";
        }

        console.log(
            "Live pickup: sign model stored " +
            signFramesPerSecond().toFixed(1) +
            " frames/s. The last " + frameTimes.length +
            " frames cover " + Math.round(windowSpanMs()) +
            "ms." + camera
        );
    }

    function start() {
        session++;
        resetSequence();
        active = true;
        sending = false;

        console.log("SignBridge live LSTM test started");
    }

    function stop() {
        session++;
        active = false;
        resetSequence();

        console.log("SignBridge live LSTM test stopped");
    }

    function commitPrediction(result) {
    if (!result || !result.prediction || result.prediction === "NONE") {
        pendingLabel = null;
        pendingCount = 0;
        return;
    }

    // Reject predictions with insufficient confidence
    if (
        typeof result.confidence !== "number" ||
        result.confidence < MIN_CONFIDENCE
    ) {
        pendingLabel = null;
        pendingCount = 0;
        return;
    }

    if (result.prediction === pendingLabel) {
        pendingCount++;
    } else {
        pendingLabel = result.prediction;
        pendingCount = 1;
    }

    if (pendingCount < STABLE_COUNT) {
        return;
    }

    window.dispatchEvent(
        new CustomEvent("signbridge:lstm-prediction", {
            detail: result
        })
    );
}
    async function sendPrediction(sequence, requestSession) {

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    frames: sequence
                })
            });

            if (!response.ok) {
                const errorText = await response.text();

                throw new Error(
                    `API ${response.status}: ${errorText}`
                );
            }

            const result = await response.json();
                console.log("Raw LSTM prediction:", {
                prediction: result.prediction,
                confidence: result.confidence,
                probabilities: result.probabilities
                });
            if (!active || requestSession !== session) return;

            commitPrediction(result);

        } catch (error) {
            if (active && requestSession === session) {
                console.error("Live prediction failed:", error);
            }

        } finally {
            if (requestSession !== session) return;
            sending = false;
            maybeSend();
        }
    }

    function lerpNum(a, b, t) {
        return a + (b - a) * t;
    }

    function lerpPoint(a, b, t) {
        if (!a && !b) return null;
        if (!a) return { x: b.x, y: b.y, z: b.z || 0 };
        if (!b) return { x: a.x, y: a.y, z: a.z || 0 };
        return {
            x: lerpNum(a.x, b.x, t),
            y: lerpNum(a.y, b.y, t),
            z: lerpNum(a.z || 0, b.z || 0, t)
        };
    }

    function cloneLandmarks(landmarks) {
        const copy = {};
        for (const name in landmarks) {
            const point = landmarks[name];
            copy[name] = point
                ? { x: point.x, y: point.y, z: point.z || 0 }
                : null;
        }
        return copy;
    }

    function lerpHand(a, b, t) {
        const aOn = !!(a && a.detected && a.landmarks);
        const bOn = !!(b && b.detected && b.landmarks);
        if (!aOn && !bOn) {
            return { detected: false, landmarks: null };
        }
        if (!aOn) {
            return t >= 0.5
                ? { detected: true, landmarks: cloneLandmarks(b.landmarks) }
                : { detected: false, landmarks: null };
        }
        if (!bOn) {
            return t < 0.5
                ? { detected: true, landmarks: cloneLandmarks(a.landmarks) }
                : { detected: false, landmarks: null };
        }
        const landmarks = {};
        const names = {};
        for (const name in a.landmarks) names[name] = true;
        for (const name in b.landmarks) names[name] = true;
        for (const name in names) {
            landmarks[name] = lerpPoint(a.landmarks[name], b.landmarks[name], t);
        }
        return { detected: true, landmarks: landmarks };
    }

    function lerpFrame(a, b, t, index) {
        const pose = {};
        const poseNames = {};
        const aPose = a.pose || {};
        const bPose = b.pose || {};
        for (const name in aPose) poseNames[name] = true;
        for (const name in bPose) poseNames[name] = true;
        for (const name in poseNames) {
            pose[name] = lerpPoint(aPose[name], bPose[name], t);
        }
        return {
            frame: index,
            leftHand: lerpHand(a.leftHand, b.leftHand, t),
            rightHand: lerpHand(a.rightHand, b.rightHand, t),
            pose: pose
        };
    }

    // Spread a short capture evenly across the 60 frames the model requires.
    function resampleFrames(source, targetCount) {
        if (source.length === targetCount) {
            return source.map(function (frame, index) {
                return lerpFrame(frame, frame, 0, index);
            });
        }
        const out = new Array(targetCount);
        const last = source.length - 1;
        for (let i = 0; i < targetCount; i++) {
            const pos = (i * last) / (targetCount - 1);
            const i0 = Math.floor(pos);
            const i1 = Math.min(last, i0 + 1);
            out[i] = lerpFrame(source[i0], source[i1], pos - i0, i);
        }
        return out;
    }

    function sourceFrames() {
        const count = frames.length;
        if (count < MIN_SOURCE_FRAMES) return null;
        const span = windowSpanMs();
        if (span < WINDOW_MS) return null;
        const start = frameTimes[count - 1] - WINDOW_MS;
        let index = 0;
        while (index < count - 1 && frameTimes[index] < start) index++;
        const source = frames.slice(index);
        if (source.length < MIN_SOURCE_FRAMES) return null;
        return source;
    }

    function maybeSend() {
        if (!active || sending) return;
        if (framesSinceSend < STRIDE) return;
        const source = sourceFrames();
        if (!source) return;

        const sequence = resampleFrames(source, SEQUENCE_LENGTH);
        const requestSession = session;
        framesSinceSend = 0;
        sending = true;

        // Stringify on a later turn so this detection can paint first.
        setTimeout(function () {
            if (!active || requestSession !== session) return;
            sendPrediction(sequence, requestSession);
        }, 0);
    }

    function processFrame(results, leftHand, rightHand) {

        if (!active) {
            return;
        }

        const converter =
            window.TrainingRecorder?.createReadableFrame;

        if (typeof converter !== "function") {
            console.error(
                "TrainingRecorder.createReadableFrame is unavailable"
            );

            stop();
            return;
        }

        const frame = converter(
            results,
            leftHand,
            rightHand,
            frames.length
        );

        if (!frame) {
            const now = Date.now();
            if (now - lastSkipLog > 2000) {
                lastSkipLog = now;
                console.warn(
                    "LSTM frame skipped: both shoulders must be in frame."
                );
            }
            return;
        }

        /* Keep the raw detections that cover the short window, then resample to 60. */
        frames.push(frame);
        frameTimes.push(performance.now());
        const newest = frameTimes[frameTimes.length - 1];
        const keepAfter = newest - WINDOW_MS - 250;
        while (frameTimes.length > MIN_SOURCE_FRAMES && frameTimes[0] < keepAfter) {
            frameTimes.shift();
            frames.shift();
        }
        framesSinceSend++;
        reportRate();
        maybeSend();
    }

    function status() {
        return {
            active,
            sending,
            collectedFrames: frames.length,
            framesSinceSend: framesSinceSend,
            pendingLabel: pendingLabel,
            pendingCount: pendingCount,
            windowSpanMs: Math.round(windowSpanMs()),
            signFramesPerSecond: Number(signFramesPerSecond().toFixed(1))
        };
    }

    window.SignBridgeLiveTest = {
        start,
        stop,
        processFrame,
        status
    };

})();
