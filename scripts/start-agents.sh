#!/usr/bin/env bash
# Mozzie — Start ACP bridge servers
# Run this before opening Mozzie.
# Requires: Node.js + the respective CLI tools installed globally.

SCRIPT="$(cd "$(dirname "$0")" && pwd)/acp-server.js"

echo "Starting Mozzie ACP bridge servers..."

node "$SCRIPT" --agent claude-code --port 8330 &
PID_CLAUDE=$!

node "$SCRIPT" --agent gemini-cli  --port 8331 &
PID_GEMINI=$!

node "$SCRIPT" --agent codex-cli   --port 8332 &
PID_CODEX=$!

echo "  Claude Code  → http://localhost:8330  (pid $PID_CLAUDE)"
echo "  Gemini CLI   → http://localhost:8331  (pid $PID_GEMINI)"
echo "  Codex CLI    → http://localhost:8332  (pid $PID_CODEX)"
echo ""
echo "Press Ctrl+C to stop all servers."

# Wait and forward Ctrl+C to all children.
trap "kill $PID_CLAUDE $PID_GEMINI $PID_CODEX 2>/dev/null; exit 0" INT TERM
wait
