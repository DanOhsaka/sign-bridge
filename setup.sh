#!/usr/bin/env bash
# SignBridge local setup (macOS and Linux).
# From the repo root:
#   chmod +x setup.sh && ./setup.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step() {
  printf '\n==> %s\n' "$1"
}

python_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' >/dev/null 2>&1
}

find_python() {
  local candidate
  for candidate in python3.12 python3.13 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && python_ok "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

echo "SignBridge setup"
echo "Repo: $ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org and run this script again." >&2
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $(node -v) is installed. SignBridge needs Node.js 18 or newer." >&2
  exit 1
fi
echo "Node.js $(node -v) is already installed."

step "Installing Node packages"
if [ ! -f package-lock.json ]; then
  echo "package-lock.json is missing. Clone the full repository and run this script from the repo root." >&2
  exit 1
fi
npm ci

if ! PYTHON="$(find_python)"; then
  echo "Python 3.10-3.13 was not found. TensorFlow does not publish wheels for Python 3.14." >&2
  echo "Install Python 3.12 and run this script again." >&2
  echo "  macOS:  brew install python@3.12" >&2
  echo "  Debian/Ubuntu: sudo apt install python3.12 python3.12-venv" >&2
  exit 1
fi
echo "Python $($PYTHON -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') is already installed ($PYTHON)."

VENV_PYTHON="$ROOT/.venv/bin/python"
if [ -x "$VENV_PYTHON" ] && ! python_ok "$VENV_PYTHON"; then
  step "Replacing .venv because it was created with a Python version TensorFlow cannot use"
  rm -rf "$ROOT/.venv"
fi

if [ ! -x "$VENV_PYTHON" ]; then
  step "Creating a Python virtual environment in .venv"
  "$PYTHON" -m venv "$ROOT/.venv"
fi

step "Installing Python packages (TensorFlow is large; this can take several minutes)"
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$ROOT/ml/requirements.txt"

if [ ! -f "$ROOT/server/.env.example" ]; then
  echo "server/.env.example is missing." >&2
  exit 1
fi

if [ -f "$ROOT/server/.env" ]; then
  echo "server/.env already exists, so it was left unchanged."
else
  step "Creating server/.env"
  SECRET="$("$VENV_PYTHON" -c 'import secrets; print(secrets.token_hex(32))')"
  sed "s/^JWT_SECRET=replace-with-a-long-random-string/JWT_SECRET=${SECRET}/" \
    "$ROOT/server/.env.example" > "$ROOT/server/.env"
  echo "Created server/.env with a new JWT_SECRET."
fi

MODEL="$ROOT/ml/models/signbridge_lstm.keras"
if [ ! -f "$MODEL" ] || [ "$(wc -c < "$MODEL")" -lt 100000 ]; then
  echo "ml/models/signbridge_lstm.keras is missing or too small. Pull the latest repo before starting the model API."
else
  echo "Sign model file is present."
fi

step "Checking MongoDB"
if "$VENV_PYTHON" -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect(("127.0.0.1", 27017)); s.close()' >/dev/null 2>&1; then
  echo "MongoDB is accepting connections on 127.0.0.1:27017."
else
  echo "MongoDB is not running on 127.0.0.1:27017."
  echo "The site still starts. Register and login need a database."
  echo "Install MongoDB Community and keep MONGODB_URI in server/.env,"
  echo "or paste a MongoDB Atlas connection string into MONGODB_URI."
  echo "  macOS: brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community"
fi

printf '\nSetup finished.\n\n'
echo "Start the sign model in one terminal:"
echo "  .venv/bin/python -m uvicorn ml.api:app --host 127.0.0.1 --port 9001"
echo
echo "Start the app in a second terminal:"
echo "  node server/index.js"
echo
echo "Open http://localhost:3000"
echo "Live hand tracking loads MediaPipe from the internet the first time you turn the camera on."
