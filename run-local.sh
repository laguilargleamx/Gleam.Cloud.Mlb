#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR"

if [[ ! -f "$BACKEND_DIR/app/main.py" ]]; then
  echo "Error: backend not found at $BACKEND_DIR"
  exit 1
fi

if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  echo "Error: package.json not found at $FRONTEND_DIR"
  exit 1
fi

if [[ -x "$BACKEND_DIR/.venv/Scripts/python.exe" ]]; then
  PYTHON_CMD="$BACKEND_DIR/.venv/Scripts/python.exe"
elif [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  PYTHON_CMD="$BACKEND_DIR/.venv/bin/python"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
else
  echo "Error: Python not found."
  exit 1
fi

cleanup() {
  echo ""
  echo "Stopping local services..."
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Installing backend dependencies (if needed)..."
"$PYTHON_CMD" -m pip install -r "$BACKEND_DIR/requirements.txt" >/dev/null

echo "Starting backend on http://127.0.0.1:8000 ..."
(
  cd "$BACKEND_DIR"
  "$PYTHON_CMD" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
) &
BACKEND_PID=$!

echo "Starting frontend on http://127.0.0.1:5173 ..."
(
  cd "$FRONTEND_DIR"
  npm run dev
) &
FRONTEND_PID=$!

echo "Both services are up. Press Ctrl+C to stop."
wait "$FRONTEND_PID"
