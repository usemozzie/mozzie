# Mozzie

A local-first desktop app for orchestrating AI coding agents across your codebase. Manage multiple agents working in parallel, each in isolated git worktrees, with dependency tracking and a built-in review workflow.

## Features

- **Multi-agent orchestration** — Run multiple AI agents (Claude Code, Gemini CLI, Codex CLI) simultaneously on different tasks
- **Git worktree isolation** — Each work item gets its own worktree so agents never conflict
- **LLM-powered planner** — Describe what you want built and the orchestrator breaks it into work items, assigns agents, and manages dependencies
- **Review workflow** — Inspect diffs, approve to merge/push, reject to re-run with feedback
- **Dependency tracking** — Work items can depend on each other; blocked items auto-launch when dependencies are approved
- **Sub-work-items** — Break features into child tasks that merge into a parent branch before pushing
- **Live streaming** — Watch agent output in real-time with tool call activity visualization
- **Conversation history** — Orchestrator conversations persist so you can iterate across sessions

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- Platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Install and Run

```bash
git clone https://github.com/usemozzie/mozzie.git
cd mozzie
pnpm install
pnpm dev
```

### Configure

1. Open **Settings** (gear icon) and add API keys for your LLM provider (OpenAI, Anthropic, or Gemini)
2. Add agent configurations for the coding agents you want to use (Claude Code, Gemini CLI, etc.)
3. Create a work item, assign a repo and agent, and hit play

Or use the orchestrator (`Ctrl+K`) — describe what you want built and let it create the work items for you.

## Architecture

```
mozzie/
├── apps/desktop/             # Tauri 2.0 desktop app
│   ├── src/                  # React frontend (TypeScript)
│   └── src-tauri/            # Rust backend
├── packages/
│   ├── db/                   # SQLite schema and type definitions
│   ├── agent-sdk/            # Agent communication types
│   └── ui/                   # Shared UI components
```

**Stack:** Tauri 2.0 + React 18 + TypeScript + Tailwind CSS + SQLite + TanStack Query + Zustand

Agents communicate via [ACP](https://github.com/anthropics/agent-client-protocol) (Agent Communication Protocol) over stdio transport.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for information about API key storage and agent execution model.

## License

[MIT](LICENSE)
