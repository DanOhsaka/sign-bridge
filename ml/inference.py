
from pathlib import Path

import numpy as np
import tensorflow as tf

from .dataset import frame_to_features


SEQUENCE_LENGTH = 30
FEATURE_COUNT = 146


class SignBridgeLSTM:

    def __init__(self, model_directory=None):

        if model_directory is None:
            model_directory = (
                Path(__file__).resolve().parent / "models"
            )

        model_directory = Path(model_directory)

        self.model = tf.keras.models.load_model(
            model_directory / "signbridge_lstm.keras",
            compile=False
        )

        with open(
            model_directory / "labels.txt",
            "r",
            encoding="utf-8"
        ) as file:
            self.labels = [
                line.strip()
                for line in file
                if line.strip()
            ]

        if len(self.labels) != self.model.output_shape[-1]:
            raise ValueError(
                "Number of labels does not match model outputs"
            )

        if tuple(self.model.input_shape[1:]) != (
            SEQUENCE_LENGTH,
            FEATURE_COUNT
        ):
            raise ValueError("Unexpected model input shape")

    def predict(self, frames):

        if not isinstance(frames, list):
            raise ValueError("Frames must be a list")

        if len(frames) != SEQUENCE_LENGTH:
            raise ValueError(
                f"Expected {SEQUENCE_LENGTH} frames, "
                f"received {len(frames)}"
            )

        sequence = np.asarray(
            [frame_to_features(frame) for frame in frames],
            dtype=np.float32
        )

        if sequence.shape != (
            SEQUENCE_LENGTH,
            FEATURE_COUNT
        ):
            raise ValueError(
                f"Invalid sequence shape: {sequence.shape}"
            )

        if not np.isfinite(sequence).all():
            raise ValueError("Invalid landmark coordinates")

        X = np.expand_dims(sequence, axis=0)

        probabilities = self.model.predict(
            X,
            verbose=0
        )[0]

        predicted_index = int(np.argmax(probabilities))

        return {
            "prediction": self.labels[predicted_index],
            "confidence": float(
                probabilities[predicted_index]
            ),
            "probabilities": {
                label: float(probabilities[index])
                for index, label in enumerate(self.labels)
            }
        }
