from pathlib import Path

import numpy as np
import tensorflow as tf

from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

from dataset import load_dataset


# ---------------------------------------------------------
# Training configuration
# ---------------------------------------------------------

SEQUENCE_LENGTH = 30
FEATURE_COUNT = 146

EPOCHS = 100
BATCH_SIZE = 8

RANDOM_SEED = 42


# ---------------------------------------------------------
# File locations
# ---------------------------------------------------------

BASE_DIR = Path(__file__).parent.parent

DATASET_PATH = (
    BASE_DIR
    / "training-data"
)

MODEL_DIRECTORY = (
    Path(__file__).parent
    / "models"
)

MODEL_PATH = (
    MODEL_DIRECTORY
    / "signbridge_lstm.keras"
)


# ---------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------

np.random.seed(RANDOM_SEED)
tf.random.set_seed(RANDOM_SEED)


# ---------------------------------------------------------
# Load dataset
# ---------------------------------------------------------

print()
print("Loading dataset...")

X, labels = load_dataset(
    DATASET_PATH
)


print()
print("Dataset shape:", X.shape)
print("Labels shape:", labels.shape)


# ---------------------------------------------------------
# Validate dataset shape
# ---------------------------------------------------------

if X.shape[1] != SEQUENCE_LENGTH:
    raise ValueError(
        f"Expected {SEQUENCE_LENGTH} frames, "
        f"but dataset contains {X.shape[1]}"
    )


if X.shape[2] != FEATURE_COUNT:
    raise ValueError(
        f"Expected {FEATURE_COUNT} features, "
        f"but dataset contains {X.shape[2]}"
    )


# ---------------------------------------------------------
# Convert text labels into numbers
# ---------------------------------------------------------

label_encoder = LabelEncoder()

y = label_encoder.fit_transform(
    labels
)


print()
print("Class mapping")
print("-------------")

for class_number, class_name in enumerate(
    label_encoder.classes_
):
    print(
        class_number,
        "->",
        class_name
    )


# ---------------------------------------------------------
# Split dataset into training and validation data
# ---------------------------------------------------------

X_train, X_val, y_train, y_val = train_test_split(
    X,
    y,

    test_size=0.20,

    random_state=RANDOM_SEED,

    stratify=y
)


print()
print("Dataset split")
print("-------------")

print(
    "Training samples:",
    X_train.shape[0]
)

print(
    "Validation samples:",
    X_val.shape[0]
)


# ---------------------------------------------------------
# Build LSTM model
# ---------------------------------------------------------

number_of_classes = len(
    label_encoder.classes_
)


model = tf.keras.Sequential([

    tf.keras.layers.Input(
        shape=(
            SEQUENCE_LENGTH,
            FEATURE_COUNT
        )
    ),

    tf.keras.layers.LSTM(
        128,
        return_sequences=True
    ),

    tf.keras.layers.Dropout(
        0.2
    ),

    tf.keras.layers.LSTM(
        64
    ),

    tf.keras.layers.Dropout(
        0.2
    ),

    tf.keras.layers.Dense(
        64,
        activation="relu"
    ),

    tf.keras.layers.Dense(
        number_of_classes,
        activation="softmax"
    )
])


# ---------------------------------------------------------
# Compile model
# ---------------------------------------------------------

model.compile(

    optimizer="adam",

    loss="sparse_categorical_crossentropy",

    metrics=[
        "accuracy"
    ]
)


# ---------------------------------------------------------
# Display model architecture
# ---------------------------------------------------------

print()
print("Model architecture")
print("------------------")

model.summary()


# ---------------------------------------------------------
# Train model
# ---------------------------------------------------------

print()
print("Starting training...")
print()


history = model.fit(

    X_train,
    y_train,

    validation_data=(
        X_val,
        y_val
    ),

    epochs=EPOCHS,

    batch_size=BATCH_SIZE,

    verbose=1
)


# ---------------------------------------------------------
# Evaluate model
# ---------------------------------------------------------

print()
print("Evaluating model...")


validation_loss, validation_accuracy = (
    model.evaluate(
        X_val,
        y_val,
        verbose=0
    )
)


print()
print("Final validation results")
print("------------------------")

print(
    "Loss:",
    round(validation_loss, 4)
)

print(
    "Accuracy:",
    round(
        validation_accuracy * 100,
        2
    ),
    "%"
)


# ---------------------------------------------------------
# Save trained model
# ---------------------------------------------------------

MODEL_DIRECTORY.mkdir(
    parents=True,
    exist_ok=True
)


model.save(
    MODEL_PATH
)


print()
print(
    "Model saved to:",
    MODEL_PATH
)


# ---------------------------------------------------------
# Save class names
# ---------------------------------------------------------

LABEL_PATH = (
    MODEL_DIRECTORY
    / "labels.txt"
)


with open(
    LABEL_PATH,
    "w",
    encoding="utf-8"
) as file:

    for class_name in label_encoder.classes_:

        file.write(
            class_name + "\n"
        )


print(
    "Labels saved to:",
    LABEL_PATH
)