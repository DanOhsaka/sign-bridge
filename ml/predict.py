
import argparse
from pathlib import Path

import numpy as np
import tensorflow as tf

from dataset import load_sample


# ---------------------------------------------------------
# File locations
# ---------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"

MODEL_PATH = MODEL_DIR / "signbridge_lstm.keras"
LABEL_PATH = MODEL_DIR / "labels.txt"


# ---------------------------------------------------------
# Load the trained model and class labels
# ---------------------------------------------------------

def load_predictor():

    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Model not found: {MODEL_PATH}"
        )

    if not LABEL_PATH.is_file():
        raise FileNotFoundError(
            f"Labels not found: {LABEL_PATH}"
        )

    model = tf.keras.models.load_model(
        MODEL_PATH,
        compile=False
    )

    with open(LABEL_PATH, "r", encoding="utf-8") as file:
        class_names = [
            line.strip()
            for line in file
            if line.strip()
        ]

    if len(class_names) != model.output_shape[-1]:
        raise ValueError(
            "Number of labels does not match "
            "the model output size."
        )

    return model, class_names


# ---------------------------------------------------------
# Predict one JSON recording
# ---------------------------------------------------------

def predict_sign(file_path, model, class_names):

    # Reuse our existing JSON-to-feature conversion.
    sequence, actual_label = load_sample(file_path)

    # One recording: (30, 146)
    # One-item batch: (1, 30, 146)
    X = np.expand_dims(sequence, axis=0)

    if tuple(X.shape[1:]) != tuple(model.input_shape[1:]):
        raise ValueError(
            f"Input shape {X.shape[1:]} does not match "
            f"model input {model.input_shape[1:]}"
        )

    # Run inference.
    probabilities = model.predict(
        X,
        verbose=0
    )[0]

    predicted_index = int(np.argmax(probabilities))
    predicted_label = class_names[predicted_index]

    return {
        "predicted_label": predicted_label,
        "actual_label": actual_label,
        "confidence": float(probabilities[predicted_index]),
        "probabilities": probabilities
    }


# ---------------------------------------------------------
# Display prediction results
# ---------------------------------------------------------

def print_prediction(file_path, result, class_names):

    print()
    print("SignBridge LSTM Prediction")
    print("--------------------------")

    print("File:", file_path)
    print("Predicted sign:", result["predicted_label"])
    print(
        "Confidence:",
        f'{result["confidence"] * 100:.2f}%'
    )

    print()
    print("Class probabilities:")

    for label, probability in zip(
        class_names,
        result["probabilities"]
    ):
        print(
            f"  {label}: {probability * 100:.2f}%"
        )

    # The label is used only for evaluation,
    # never as an input to the model.
    actual_label = result["actual_label"]

    if actual_label:
        print()
        print("Expected sign:", actual_label)

        if actual_label == result["predicted_label"]:
            print("Result: CORRECT")
        else:
            print("Result: INCORRECT")


# ---------------------------------------------------------
# Command-line entry point
# ---------------------------------------------------------

def main():

    parser = argparse.ArgumentParser(
        description="Predict a sign from a MediaPipe JSON recording."
    )

    parser.add_argument(
        "file",
        type=Path,
        help="Path to a hands-arms-v2 JSON recording"
    )

    args = parser.parse_args()

    if not args.file.is_file():
        parser.error(
            f"JSON file does not exist: {args.file}"
        )

    model, class_names = load_predictor()

    result = predict_sign(
        args.file,
        model,
        class_names
    )

    print_prediction(
        args.file,
        result,
        class_names
    )


if __name__ == "__main__":
    main()
