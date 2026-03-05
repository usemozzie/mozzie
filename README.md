# Mozzie — Multi-Agent Build System

## Quick Start

```bash
# 1. Clone and enter the project directory
git init mozzie && cd mozzie

# 2. Copy this entire directory structure into your project root
#    (agents/, docs/, scripts/, CLAUDE.md)

# 3. Run the full build pipeline
chmod +x scripts/launch-agents.sh
./scripts/launch-agents.sh
```

## What This Does

This system uses **4 Claude Code agents** working in parallel to build the Mozzie desktop app. Each agent has a strictly scoped task with defined file ownership to prevent merge conflicts.

```
Task A (Scaffold)  ──────────────────────┐
  Creates: monorepo, types, migrations,  │
  Tauri config, build pipeline           │
                                         ▼
                              ┌─── Task B (PTY/Terminals)
                              │     Creates: Rust PTY pool,
                              │     xterm.js grid, terminal hooks
                              │
                              ├─── Task C (Tickets/UI)
                              │     Creates: ticket CRUD, state machine,
                              │     left panel, React components
                              │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              Task D (Orchestration)
                                Creates: agent spawning, git worktree,
                                review UI, settings, final layout
```

## Running Individual Tasks

If a task fails or you want to iterate on a specific piece:

```bash
# Run just the scaffolding
./scripts/launch-agents.sh --task a

# Run just the terminal system (requires Task A complete)
./scripts/launch-agents.sh --task b

# Run B and C in parallel (requires Task A complete)
./scripts/launch-agents.sh --parallel

# Resume from Task D (requires A, B, C complete)
./scripts/launch-agents.sh --resume d
```

## Manual Agent Execution

If you prefer to run agents manually or in separate terminal windows:

```bash
# Terminal 1: Run Task A first
claude -p "$(cat agents/task-a-scaffold.md)" --allowedTools "Bash(command:*),Read,Write,Edit"

# Terminal 2: After Task A, run Task B
claude -p "$(cat agents/task-b-pty-terminals.md)" --allowedTools "Bash(command:*),Read,Write,Edit"

# Terminal 3: After Task A, run Task C (can run simultaneously with B)
claude -p "$(cat agents/task-c-tickets-ui.md)" --allowedTools "Bash(command:*),Read,Write,Edit"

# Terminal 4: After B and C complete, run Task D
claude -p "$(cat agents/task-d-orchestration.md)" --allowedTools "Bash(command:*),Read,Write,Edit"
```

## Build Logs

All agent output is logged to `.mozzie-build-logs/`:
- `Task-A-Scaffold.log`
- `Task-B-PTY-Terminals.log`
- `Task-C-Tickets-UI.log`
- `Task-D-Orchestration.log`

## File Ownership Map

Each task owns specific files. This prevents agents from stepping on each other:

| Path | Owner |
|------|-------|
| `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.*.json` | Task A |
| `packages/db/`, `packages/agent-sdk/`, `packages/ui/` | Task A |
| `apps/desktop/src-tauri/tauri.conf.json` | Task A |
| `apps/desktop/src-tauri/src/pty/` | Task B |
| `apps/desktop/src/components/terminal/` | Task B |
| `apps/desktop/src/hooks/useTerminal.ts`, `usePty.ts` | Task B |
| `apps/desktop/src-tauri/src/commands/tickets.rs` | Task C |
| `apps/desktop/src/components/tickets/`, `ui/` | Task C |
| `apps/desktop/src/stores/` | Task C |
| `apps/desktop/src-tauri/src/agents/` | Task D |
| `apps/desktop/src-tauri/src/commands/agents.rs`, `worktree.rs` | Task D |
| `apps/desktop/src/components/review/`, `settings/` | Task D |
| `apps/desktop/src/App.tsx` (final assembly) | Task D |

## Troubleshooting

**Task fails midway:** Use `--resume` to pick up from where it left off. Check the build log for the specific error.

**Type errors after Task A:** Ensure `pnpm install` ran successfully. Check that `packages/db/src/schema.ts` exports all types.

**Tauri won't compile:** Check `Cargo.toml` for missing dependencies. Run `cargo check` in `apps/desktop/src-tauri/` for Rust errors.

**Agents conflict on a file:** This shouldn't happen if ownership is respected. If it does, the later task's version should take precedence since it has more context.
