(function () {
    "use strict";

    // Node proxy on the same origin. The server forwards to the Python model.
    const API_URL = "/api/predict";
    const SEQUENCE_LENGTH = 30;
    /* Keep overlap so the next window starts sooner after a send. */
    const KEEP_AFTER_SEND = 12;

    let active = false;
    let sending = false;
    let session = 0;
    let frames = [];
    let lastSkipLog = 0;
    let lastSendMs = 0;

    function start() {
        session++;
        frames = [];
        active = true;
        sending = false;

        console.log("SignBridge live LSTM test started");
    }

    function stop() {
        session++;
        active = false;
        sending = false;
        frames = [];

        console.log("SignBridge live LSTM test stopped");
    }

    async function sendPrediction(sequence) {

        const requestSession = session;
        sending = true;
        const t0 = performance.now();

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

            result.apiMs = performance.now() - t0;

            console.log("--------------------------");
            console.log("SignBridge Live Prediction");
            console.log("--------------------------");

            console.log("Sign:", result.prediction);

            console.log(
                "Confidence:",
                (result.confidence * 100).toFixed(2) + "%"
            );

            console.log("API ms:", result.apiMs.toFixed(0));

            console.table(result.probabilities);

            window.dispatchEvent(
                new CustomEvent("signbridge:lstm-prediction", {
                    detail: result
                })
            );

        } catch (error) {
            if (active && requestSession === session) {
                console.error("Live prediction failed:", error);
            }

        } finally {
            sending = false;
            lastSendMs = performance.now();
        }
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

        /* Always keep the latest window — do not stall collection while HTTP is in flight. */
        frames.push(frame);
        if (frames.length > SEQUENCE_LENGTH) {
            frames = frames.slice(frames.length - SEQUENCE_LENGTH);
        }

        if (sending) {
            return;
        }

        if (frames.length >= SEQUENCE_LENGTH) {
            const sequence = frames.slice(0, SEQUENCE_LENGTH);
            /* Sliding overlap: keep recent frames for a quicker next window */
            frames = frames.slice(Math.max(0, SEQUENCE_LENGTH - KEEP_AFTER_SEND));
            sendPrediction(sequence);
        }
    }

    function status() {
        return {
            active,
            sending,
            collectedFrames: frames.length,
            lastSendMs
        };
    }

    window.SignBridgeLiveTest = {
        start,
        stop,
        processFrame,
        status
    };

})();
