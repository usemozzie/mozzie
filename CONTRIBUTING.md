# Contributing to Mozzie

Thanks for your interest in contributing! Mozzie is a Tauri 2.0 desktop app for AI agent orchestration.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/) prerequisites for your OS

## Getting Started

```bash
# Clone the repo
git clone https://github.com/usemozzie/mozzie.git
cd mozzie

# Install dependencies
pnpm install

# Run in development mode
pnpm dev
```

This starts the Tauri dev server with hot reload for the React frontend and Rust backend.

## Project Structure

```
mozzie/
├── apps/desktop/             # Tauri desktop application
│   ├── src/                  # React frontend
│   │   ├── components/       # UI components
│   │   ├── hooks/            # React hooks (TanStack Query)
│   │   ├── stores/           # Zustand state stores
│   │   ├── lib/              # Utilities
│   │   └── types/            # Shared TypeScript types
│   └── src-tauri/            # Rust backend
│       ├── src/commands/     # Tauri IPC commands
│       └── migrations/       # SQLite migrations
├── packages/
│   ├── db/                   # Database schema and queries
│   ├── agent-sdk/            # Agent type definitions
│   └── ui/                   # Shared UI primitives
└── docs/                     # Specification documents
```

## Development Workflow

1. **Create a branch** from `main` with a descriptive name (`feat/...`, `fix/...`, `refactor/...`)
2. **Make your changes** — keep PRs focused on a single concern
3. **Type-check** before submitting: `pnpm typecheck`
4. **Test the Rust backend**: `cd apps/desktop/src-tauri && cargo check`
5. **Open a PR** against `main` with a clear description of what and why

## Architecture Notes

- **Frontend ↔ Backend**: Communication is via Tauri's `invoke()` IPC. Param names must be camelCase in JS (Tauri 2.0 converts to snake_case for Rust).
- **Database**: SQLite via `sqlx` in Rust commands. Migrations run eagerly on app startup.
- **State Management**: Zustand for UI state, TanStack Query for server state (Tauri commands).
- **Agent Communication**: ACP (Agent Communication Protocol) — agents run as child processes via stdio transport.
- **Git Isolation**: Each work item gets its own git worktree. Changes are reviewed before merging.

## Code Style

- TypeScript: Follow existing patterns. No unnecessary comments or docstrings.
- Rust: Standard `rustfmt` formatting. `cargo clippy` should pass.
- CSS: Tailwind utility classes. Use the design tokens defined in `tailwind.config.ts`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
