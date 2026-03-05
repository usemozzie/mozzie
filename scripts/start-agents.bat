@echo off
REM Mozzie — Start ACP bridge servers
REM Run this before opening Mozzie. Each window hosts one agent.
REM Requires: Node.js + the respective CLI tools installed globally.

SET SCRIPT=%~dp0acp-server.js

echo Starting Mozzie ACP bridge servers...

start "ACP: Claude Code (8330)" cmd /k "node "%SCRIPT%" --agent claude-code --port 8330"
start "ACP: Gemini CLI (8331)"  cmd /k "node "%SCRIPT%" --agent gemini-cli  --port 8331"
start "ACP: Codex CLI (8332)"   cmd /k "node "%SCRIPT%" --agent codex-cli   --port 8332"

echo.
echo Three ACP servers starting in separate windows.
echo Open Mozzie and run a ticket when ready.
