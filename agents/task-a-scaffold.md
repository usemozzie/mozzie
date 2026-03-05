# Task A: Project Scaffolding & Build System

You are an AI coding agent responsible for ONE task: setting up the Mozzie monorepo scaffolding. Read `docs/SPEC.md` fully before writing any code.

## Your Mission

Create a bootable Tauri 2.0 + React (Vite) monorepo that compiles and opens a blank dark-themed window. Every other agent depends on your output being correct. Precision matters more than speed.

## Step-by-Step Deliverables

### 1. Initialize Monorepo Root

Create these root files:

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**`turbo.json`:** Configure with `build`, `dev`, `lint`, `typecheck` pipelines. `build` in `packages/*` must run before `apps/desktop`. `dev` is persistent.

**`tsconfig.base.json`:** Strict TypeScript config. Target ES2022, module ESNext, moduleResolution bundler. Paths: `@mozzie/db`, `@mozzie/agent-sdk`, `@mozzie/ui`.

**`.gitignore`:** Node modules, dist, target (Rust), .mozzie/, *.db

**`package.json`:** Root package with devDependencies for `turbo`, `typescript`. Scripts: `dev`, `build`, `lint`.

### 2. Create `packages/db`

This package owns the SQLite schema and typed query helpers.

**`packages/db/package.json`:** Name `@mozzie/db`. Dependencies: `ulid`.

**`packages/db/src/schema.ts`:** Export TypeScript types matching EVERY column in the spec's 3 tables. These types are the contract for all other agents. Be precise:

```typescript
export type TicketStatus = 'draft' | 'ready' | 'queued' | 'running' | 'review' | 'done' | 'archived';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type AgentType = 'cli' | 'api';

export interface Ticket {
  id: string;
  title: string;
  context: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  tags: string; // JSON array string
  prompt: string | null;
  plan: string | null;
  repo_path: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  assigned_agent: string | null;
  terminal_slot: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AgentLog {
  id: string;
  ticket_id: string;
  agent_id: string;
  output: Uint8Array | null;
  summary: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentConfig {
  id: string;
  display_name: string;
  type: AgentType;
  command: string | null;
  api_endpoint: string | null;
  api_key_ref: string | null;
  model: string | null;
  max_concurrent: number;
  enabled: number;
}
```

**`packages/db/src/migrations.ts`:** Export the raw SQL migration strings for all 3 tables. Include indexes on `tickets.status`, `tickets.updated_at`, `agent_logs.ticket_id`.

**`packages/db/src/queries.ts`:** Export typed query helper functions (these are string builders that return SQL + params, not DB connections — the Tauri layer handles execution):
- `insertTicket(ticket: Omit<Ticket, 'id' | 'created_at' | 'updated_at'>)`
- `updateTicket(id: string, fields: Partial<Ticket>)`
- `listTickets(filters?: { status?: TicketStatus[] })`
- `getTicket(id: string)`
- `insertAgentLog(log: Omit<AgentLog, 'id' | 'created_at'>)`
- `getAgentLogs(ticketId: string)`
- `listAgentConfigs()`
- `upsertAgentConfig(config: AgentConfig)`

**`packages/db/src/index.ts`:** Barrel export everything.

### 3. Create `packages/agent-sdk`

**`packages/agent-sdk/package.json`:** Name `@mozzie/agent-sdk`.

**`packages/agent-sdk/src/types.ts`:** Export the AgentRunner, SpawnConfig, AgentProcess, AgentCapability interfaces exactly as defined in Section 5.1 of the spec.

**`packages/agent-sdk/src/index.ts`:** Barrel export.

### 4. Create `packages/ui`

**`packages/ui/package.json`:** Name `@mozzie/ui`. Dependencies: `react`, `react-dom`, `class-variance-authority`, `clsx`, `tailwind-merge`.

**`packages/ui/src/utils.ts`:** Export a `cn()` utility (clsx + tailwind-merge).

**`packages/ui/src/index.ts`:** Barrel export.

### 5. Create `apps/desktop` — Frontend

**`apps/desktop/package.json`:** Dependencies: `react`, `react-dom`, `@tauri-apps/api`, `@tauri-apps/plugin-sql`, `zustand`, `@tanstack/react-query`, `xterm`, `xterm-addon-fit`, `xterm-addon-webgl`, `react-resizable-panels`, `@tiptap/react`, `@tiptap/starter-kit`, `lucide-react`. Dev deps: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `autoprefixer`, `typescript`.

Workspace deps: `@mozzie/db: "workspace:*"`, `@mozzie/agent-sdk: "workspace:*"`, `@mozzie/ui: "workspace:*"`.

**`apps/desktop/vite.config.ts`:** Standard Tauri Vite config. Ensure `clearScreen: false`, `server.strictPort: true`.

**`apps/desktop/tailwind.config.ts`:** Content paths include `../../packages/ui/src/**/*.{ts,tsx}`. Add the dark theme colors from the spec:
```
colors: {
  bg: '#0F0F12',
  surface: '#1A1A22',
  border: '#2A2A35',
  text: '#E0E0E8',
  accent: '#3B82F6',
}
```

**`apps/desktop/src/main.tsx`:** Minimal React mount. Render a single `<div>` with the dark background and text "Mozzie" centered. This proves the build works.

**`apps/desktop/src/types/events.ts`:** Export TypeScript types for all Tauri events:
```typescript
export interface PtyOutputEvent {
  data: number[];
}

export interface PtyExitEvent {
  code: number;
  ticketId: string;
}

export interface TicketStateChangeEvent {
  ticketId: string;
  from: string;
  to: string;
}
```

**`apps/desktop/index.html`:** Standard Vite HTML entry pointing to `src/main.tsx`.

### 6. Create `apps/desktop/src-tauri` — Rust Backend

**`Cargo.toml`:** Dependencies: `tauri` (with features: `"devtools"`), `tauri-plugin-sql` (with `"sqlite"` feature), `serde`, `serde_json`, `portable-pty`, `zstd`, `tokio` (full features), `ulid`.

**`tauri.conf.json`:** 
- `productName`: "Mozzie"
- `identifier`: "dev.mozzie.app"
- `build.beforeDevCommand`: "pnpm dev" (relative to apps/desktop)
- `build.beforeBuildCommand`: "pnpm build"
- `build.devUrl`: "http://localhost:1420"
- `build.frontendDist`: "../dist"
- Window: title "Mozzie", width 1400, height 900, minWidth 1000, minHeight 700, decorations true, transparent false
- Enable the `sql` plugin

**`src/lib.rs`:** Setup Tauri with:
- `tauri_plugin_sql` (SQLite)
- Run migrations on startup (read from a const SQL string matching the schema)
- Seed default agent configs (claude-code, gemini-cli, codex-cli, custom) on first run
- Register empty stub commands: `spawn_agent`, `write_to_pty`, `resize_pty`, `kill_process`, `get_output_buffer`, `create_ticket`, `update_ticket`, `list_tickets`, `get_ticket`, `transition_ticket`, `create_worktree`, `remove_worktree`, `get_diff`, `list_agent_configs`, `upsert_agent_config`
- Each stub command just returns `Ok(())` or an empty default. Other agents will implement them.

**`src/pty/mod.rs`:** Empty module with `// Implemented by Task B` comment.

**`src/commands/mod.rs`:** Module declarations for `pty`, `tickets`, `agents`, `worktree`. Each submodule is an empty file with a comment noting which task implements it.

**`src/agents/mod.rs`:** Empty module with `// Implemented by Task D` comment.

**`migrations/001_init.sql`:** The complete SQL schema for all 3 tables + indexes.

### 7. Verify the Build

After creating all files:

```bash
pnpm install
cd apps/desktop
pnpm tauri dev
```

The app must compile (Rust + TS) and open a window with the dark background. If it doesn't, fix it before declaring the task done.

## Completion Criteria

- [ ] `pnpm install` succeeds at root with no errors
- [ ] `pnpm build` in each package succeeds
- [ ] `pnpm tauri dev` in apps/desktop opens a window
- [ ] SQLite database is created on first run with all 3 tables
- [ ] Default agent configs are seeded
- [ ] All TypeScript types in packages/db and packages/agent-sdk compile
- [ ] All Tauri command stubs are registered (app doesn't panic)
- [ ] Git repo initialized with `.gitignore`, initial commit on `main`

## DO NOT

- Implement any actual PTY logic (Task B)
- Build any React components beyond the minimal main.tsx (Task C)
- Implement agent spawning or worktree logic (Task D)
- Install packages not listed above
- Skip the verification step
