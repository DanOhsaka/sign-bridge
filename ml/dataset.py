import json
from pathlib import Path

import numpy as np

# x refers to the input features (coordinates) a nd y refers to the answer/ target which is the sign names
# ---------------------------------------------------------
# Dataset configuration
# ---------------------------------------------------------

SEQUENCE_LENGTH = 30

HAND_NAMES = [
    "wrist",
    "thumbCMC",
    "thumbMCP",
    "thumbIP",
    "thumbTip",

    "indexMCP",
    "indexPIP",
    "indexDIP",
    "indexTip",

    "middleMCP",
    "middlePIP",
    "middleDIP",
    "middleTip",

    "ringMCP",
    "ringPIP",
    "ringDIP",
    "ringTip",

    "pinkyMCP",
    "pinkyPIP",
    "pinkyDIP",
    "pinkyTip"
]


POSE_NAMES = [
    "leftShoulder",
    "rightShoulder",

    "leftElbow",
    "rightElbow",

    "leftWrist",
    "rightWrist"
]


# ---------------------------------------------------------
# Add one XYZ point to a feature vector
# ---------------------------------------------------------

def add_point(features, point):

    if point is None:
        features.extend([0.0, 0.0, 0.0])
        return

    features.extend([
        float(point["x"]),
        float(point["y"]),
        float(point["z"])
    ])


# ---------------------------------------------------------
# Add one hand to a feature vector
# ---------------------------------------------------------

def add_hand(features, hand):

    detected = hand["detected"]

    # Presence flag
    if detected:
        features.append(1.0)
    else:
        features.append(0.0)


    # Missing hand
    if not detected or hand["landmarks"] is None:

        # 21 landmarks × XYZ
        features.extend([0.0] * 63)

        return


    landmarks = hand["landmarks"]


    # Always extract landmarks in the exact same order.
    for name in HAND_NAMES:

        point = landmarks.get(name)

        add_point(features, point)


# ---------------------------------------------------------
# Convert one readable JSON frame into numbers
# ---------------------------------------------------------

def frame_to_features(frame):

    features = []

    left_hand = frame["leftHand"]
    right_hand = frame["rightHand"]


    # -------------------------------------------------
    # 1. HAND DETECTION FLAGS
    # Features 0-1
    # -------------------------------------------------

    features.append(
        1.0 if left_hand["detected"] else 0.0
    )

    features.append(
        1.0 if right_hand["detected"] else 0.0
    )


    # -------------------------------------------------
    # 2. LEFT HAND COORDINATES
    # Features 2-64
    # -------------------------------------------------

    if left_hand["detected"] and left_hand["landmarks"] is not None:

        for name in HAND_NAMES:
            point = left_hand["landmarks"].get(name)
            add_point(features, point)

    else:
        # 21 landmarks × XYZ
        features.extend([0.0] * 63)


    # -------------------------------------------------
    # 3. RIGHT HAND COORDINATES
    # Features 65-127
    # -------------------------------------------------

    if right_hand["detected"] and right_hand["landmarks"] is not None:

        for name in HAND_NAMES:
            point = right_hand["landmarks"].get(name)
            add_point(features, point)

    else:
        # 21 landmarks × XYZ
        features.extend([0.0] * 63)


    # -------------------------------------------------
    # 4. POSE COORDINATES
    # Features 128-145
    # -------------------------------------------------

    pose = frame["pose"]

    for name in POSE_NAMES:

        point = pose.get(name)

        add_point(features, point)


    # Safety check
    if len(features) != 146:
        raise ValueError(
            f"Expected 146 features, got {len(features)}"
        )


    return features


# ---------------------------------------------------------
# Load one JSON training recording
# ---------------------------------------------------------

def load_sample(file_path):

    with open(
        file_path,
        "r",
        encoding="utf-8"
    ) as file:

        sample = json.load(file)


    # Validate JSON version.
    if sample.get("formatVersion") != 2:

        raise ValueError(
            f"{file_path} is not formatVersion 2"
        )


    # Validate sequence length.
    frames = sample["frames"]

    if len(frames) != SEQUENCE_LENGTH:

        raise ValueError(
            f"{file_path} contains "
            f"{len(frames)} frames instead of "
            f"{SEQUENCE_LENGTH}"
        )


    sequence = []


    for frame in frames:

        features = frame_to_features(frame)

        sequence.append(features)


    return (
        np.array(sequence, dtype=np.float32),
        sample["label"]
    )


# ---------------------------------------------------------
# Load every JSON file from a dataset directory
# ---------------------------------------------------------

def load_dataset(dataset_directory):

    dataset_directory = Path(dataset_directory)

    json_files = sorted(
        dataset_directory.rglob("*.json")
    )


    if not json_files:

        raise ValueError(
            f"No JSON files found in "
            f"{dataset_directory}"
        )


    samples = []
    labels = []


    for file_path in json_files:

        sequence, label = load_sample(
            file_path
        )

        samples.append(sequence)
        labels.append(label)


    X = np.array(
        samples,
        dtype=np.float32
    )

    y = np.array(labels)


    return X, y


# ---------------------------------------------------------
# Test dataset.py directly
# ---------------------------------------------------------

if __name__ == "__main__":

    dataset_path = (
        Path(__file__).parent.parent
        / "training-data"
    )


    X, y = load_dataset(dataset_path)


    print()
    print("Dataset loaded successfully")
    print("---------------------------")

    print("Samples:", X.shape[0])
    print("Frames per sample:", X.shape[1])
    print("Features per frame:", X.shape[2])

    print()

    print(
        "Tensor shape:",
        X.shape
    )

    print()

    print(
        "Labels:",
        np.unique(y)
    )

    print()

    for label in np.unique(y):

        count = np.sum(y == label)

        print(
            label,
            ":",
            count,
            "samples"
        )
    
    print()
    print("Feature layout check")
    print("--------------------")
    
    first_frame = X[0][0]
    
    print("Total features:", len(first_frame))
    
    print(
        "Left detected:",
        first_frame[0]
    )
    
    print(
        "Right detected:",
        first_frame[1]
    )
    
    print(
        "Left hand features:",
        len(first_frame[2:65])
    )
    
    print(
        "Right hand features:",
        len(first_frame[65:128])
    )
    
    print(
        "Pose features:",
        len(first_frame[128:146])
    )