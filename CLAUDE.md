# Mozzie — Multi-Agent Build Orchestration

## Project Overview

You are building **Mozzie**, a Tauri 2.0 desktop app for AI agent orchestration. The full spec is in `docs/mozzie-phase1-spec.docx`. Read it before doing anything.

This project uses **4 parallel work streams** (Tasks A→D). You are the **orchestrator**. Your job is to spawn sub-agents for each task, ensure they don't conflict, and integrate their work.

## Critical Rules

1. **Read the spec first.** Run `cat docs/SPEC.md` before any code generation.
2. **Never modify files outside your task's scope** (see ownership below).
3. **Task A must complete scaffolding before B, C, or D begin writing code.** B and C can run in parallel after A. D runs after B and C merge.
4. **All agents share one repo.** Use git branches: `task/a-scaffold`, `task/b-pty-terminals`, `task/c-tickets-ui`, `task/d-orchestration`.

## How to Run This

From the project root, run the orchestrator:

```bash
# Step 1: Run Task A (scaffolding) first — it must finish before others start
claude -p "$(cat agents/task-a-scaffold.md)" --allowedTools "Bash,Read,Write,Edit"

# Step 2: After Task A completes, run B and C in parallel
claude -p "$(cat agents/task-b-pty-terminals.md)" --allowedTools "Bash,Read,Write,Edit" &
claude -p "$(cat agents/task-c-tickets-ui.md)" --allowedTools "Bash,Read,Write,Edit" &
wait

# Step 3: After B and C complete, run D to integrate
claude -p "$(cat agents/task-d-orchestration.md)" --allowedTools "Bash,Read,Write,Edit"
```

Or use the launcher script:

```bash
chmod +x scripts/launch-agents.sh
./scripts/launch-agents.sh
```

## File Ownership (Conflict Prevention)

Each task owns specific directories. Agents must ONLY create/edit files in their owned paths.

| Task | Owned Paths |
|------|------------|
| A | `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.*.json`, `apps/desktop/package.json`, `apps/desktop/vite.config.ts`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/src/lib.rs` (stubs only), `apps/desktop/src-tauri/migrations/`, `packages/*/package.json`, `packages/*/tsconfig.json`, `apps/desktop/src/main.tsx` (minimal), `apps/desktop/tailwind.config.ts`, `apps/desktop/index.html` |
| B | `apps/desktop/src-tauri/src/pty/`, `apps/desktop/src-tauri/src/commands/pty.rs`, `apps/desktop/src/components/terminal/`, `apps/desktop/src/hooks/useTerminal.ts`, `apps/desktop/src/hooks/usePty.ts` |
| C | `apps/desktop/src/components/tickets/`, `apps/desktop/src/components/ui/` (shadcn), `apps/desktop/src/stores/`, `apps/desktop/src/hooks/useTickets.ts`, `apps/desktop/src/hooks/useTicketMutation.ts`, `apps/desktop/src-tauri/src/commands/tickets.rs`, `packages/db/src/` |
| D | `apps/desktop/src-tauri/src/commands/agents.rs`, `apps/desktop/src-tauri/src/commands/worktree.rs`, `apps/desktop/src-tauri/src/agents/`, `apps/desktop/src/components/review/`, `apps/desktop/src/components/settings/`, `apps/desktop/src/App.tsx` (final layout assembly), `packages/agent-sdk/src/` |

## Shared Interface Contracts

All agents must use these exact type definitions. Task A creates the files; other tasks import them.

### `packages/db/src/schema.ts` (Created by Task A, used by all)
### `packages/agent-sdk/src/types.ts` (Created by Task A, used by B and D)
### `apps/desktop/src/types/events.ts` (Created by Task A, used by B, C, D)
