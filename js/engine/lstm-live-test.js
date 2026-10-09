(function () {
    "use strict";

    const API_URL = "http://127.0.0.1:9001/predict";
    const SEQUENCE_LENGTH = 30;

    let active = false;
    let sending = false;
    let session = 0;
    let frames = [];

    function start() {
        session++;
        frames = [];
        active = true;

        console.log("SignBridge live LSTM test started");
    }

    function stop() {
        session++;
        active = false;
        frames = [];

        console.log("SignBridge live LSTM test stopped");
    }

    async function sendPrediction(sequence) {

        const requestSession = session;
        sending = true;

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

            console.log("--------------------------");
            console.log("SignBridge Live Prediction");
            console.log("--------------------------");

            console.log("Sign:", result.prediction);

            console.log(
                "Confidence:",
                (result.confidence * 100).toFixed(2) + "%"
            );

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
        }
    }

    function processFrame(results, leftHand, rightHand) {

        if (!active || sending) {
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
            return;
        }

        frames.push(frame);

        if (frames.length >= SEQUENCE_LENGTH) {

            const sequence = frames.slice(0, SEQUENCE_LENGTH);

            frames = [];

            sendPrediction(sequence);
        }
    }

    function status() {
        return {
            active,
            sending,
            collectedFrames: frames.length
        };
    }

    window.SignBridgeLiveTest = {
        start,
        stop,
        processFrame,
        status
    };

})();

