(function () {
    "use strict";

    // Node proxy on the same origin. The server forwards to the Python model.
    const API_URL = "/api/predict";
    const SEQUENCE_LENGTH = 30;
    // Classify the latest 30 frames again after this many new detections.
    const STRIDE = 8;
    // One agreeing window is not enough; the next stride must match
    // before the transcript changes.
    const STABLE_COUNT = 2;

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

        console.log("SignBridge live LSTM test started");
    }

    function stop() {
        session++;
        active = false;
        resetSequence();

        console.log("SignBridge live LSTM test stopped");
    }

    function commitPrediction(result) {
        if (!result || !result.prediction) {
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

    function maybeSend() {
        if (!active || sending) return;
        if (frames.length < SEQUENCE_LENGTH) return;
        if (framesSinceSend < STRIDE) return;

        const sequence = frames.slice(-SEQUENCE_LENGTH);
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

        frames.push(frame);
        frameTimes.push(performance.now());
        if (frames.length > SEQUENCE_LENGTH) {
            frames.shift();
            frameTimes.shift();
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
