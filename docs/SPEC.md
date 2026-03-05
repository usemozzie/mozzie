# Mozzie — Phase 1 Technical Specification

## 1. Project Overview

Mozzie is a local-first desktop application for developers who want to manage work tickets and execute them using AI coding agents (Claude Code, Gemini CLI, Codex) from a single interface. The core loop: create a ticket with context → assign it to an agent → watch it execute in an embedded terminal → review the output → merge.

**Core Principle:** Your tickets, your machine, your data. No cloud dependency for the core workflow. The app works fully offline with local agents.

**Tech Stack:** Tauri 2.0 (Rust backend) + React (Vite) + Tailwind CSS + SQLite (local-first)
**Target Platforms:** macOS (primary), Windows (secondary)

## 2. Monorepo Structure

```
mozzie/
├── apps/
│   └── desktop/          # Tauri 2.0 + React (Vite) app
│       ├── src/           # React frontend
│       ├── src-tauri/     # Rust backend
│       └── package.json
├── packages/
│   ├── agent-sdk/         # Agent abstraction layer (TypeScript)
│   ├── db/                # SQLite schema, migrations, query helpers
│   └── ui/                # Shared React components (shadcn/ui)
├── agents/                # Agent prompt files for build orchestration
├── scripts/               # Build and launcher scripts
├── docs/                  # This spec and other docs
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

Uses pnpm workspaces + Turborepo for parallel builds.

## 3. Data Model

All data lives in a local SQLite database managed by `tauri-plugin-sql`.

### 3.1 Tickets Table

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (ULID) | Primary key, sortable by creation time |
| title | TEXT NOT NULL | Short ticket summary |
| context | TEXT | Full ticket context (Markdown) |
| status | TEXT NOT NULL | `draft \| ready \| queued \| running \| review \| done \| archived` |
| priority | TEXT DEFAULT 'medium' | `low \| medium \| high \| urgent` |
| tags | TEXT (JSON array) | Freeform tags for filtering |
| prompt | TEXT | Additional instruction to prepend when sending to agent |
| plan | TEXT | Execution plan (Markdown), optional |
| repo_path | TEXT | Absolute path to the target git repository |
| branch_name | TEXT | Auto-generated branch name for worktree |
| worktree_path | TEXT | Path to the git worktree directory |
| assigned_agent | TEXT | Agent ID from agent config (e.g. claude-code) |
| terminal_slot | INTEGER | Which terminal tile (0–7) this ticket occupies |
| created_at | TEXT (ISO 8601) | Ticket creation timestamp |
| updated_at | TEXT (ISO 8601) | Last modification timestamp |
| started_at | TEXT (ISO 8601) | When agent execution began |
| completed_at | TEXT (ISO 8601) | When agent execution finished |

### 3.2 Agent Logs Table

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (ULID) | Primary key |
| ticket_id | TEXT NOT NULL | FK to tickets.id |
| agent_id | TEXT NOT NULL | Which agent produced this log |
| output | BLOB | Full terminal output (compressed) |
| summary | TEXT | AI-generated summary of what the agent did |
| tokens_in | INTEGER | Input tokens consumed |
| tokens_out | INTEGER | Output tokens consumed |
| cost_usd | REAL | Estimated cost in USD |
| exit_code | INTEGER | Process exit code |
| duration_ms | INTEGER | Execution duration in milliseconds |
| created_at | TEXT (ISO 8601) | Log creation timestamp |

### 3.3 Agent Config Table

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique agent identifier (e.g. claude-code) |
| display_name | TEXT | Human-readable name |
| type | TEXT | `cli \| api` |
| command | TEXT | For CLI agents: shell command template |
| api_endpoint | TEXT | For API agents: base URL |
| api_key_ref | TEXT | Reference to OS keychain entry |
| model | TEXT | Model identifier |
| max_concurrent | INTEGER DEFAULT 1 | Max parallel instances |
| enabled | INTEGER DEFAULT 1 | Whether agent is available |

## 4. Ticket State Machine

```
draft → ready → queued → running → review → done → archived
                  ↑         ↑        │  │
                  │         │        │  └→ ready (reject)
                  │         └────────┘
                  └── ready (unassign)
```

| State | Description | Allowed Transitions |
|-------|-------------|---------------------|
| draft | Being composed. Context/prompt editable. | → ready |
| ready | Complete, can be assigned to agent. | → queued, → draft |
| queued | Has assigned agent + terminal slot, waiting to start. | → running, → ready |
| running | Agent actively executing. Terminal live. Ticket locked. | → review (auto on exit), → ready (abort) |
| review | Agent finished. Output captured. User reviews. | → done (approve), → ready (reject) |
| done | Worktree merged or changes accepted. | → archived |
| archived | Soft-deleted. Kept for history. | (terminal) |

### Transition Rules

- **draft → ready:** Requires non-empty title, context, and repo_path.
- **ready → queued:** User selects agent + terminal slot (0–7). Git worktree created at this point.
- **queued → running:** User clicks "Run". Agent process spawned. Fields become read-only.
- **running → review:** Auto-triggered on process exit. Output captured and compressed.
- **review → done:** User approves. Worktree merged to source branch.
- **review → ready:** User rejects. Worktree cleaned up. Ticket returns for re-assignment.

## 5. Agent Abstraction Layer

### 5.1 AgentRunner Interface

```typescript
interface AgentRunner {
  id: string;
  displayName: string;
  type: 'cli' | 'api';
  spawn(config: SpawnConfig): Promise<AgentProcess>;
  abort(processId: string): Promise<void>;
  getCapabilities(): AgentCapability[];
}

interface SpawnConfig {
  ticketId: string;
  workingDir: string;       // worktree path
  prompt: string;           // combined context + prompt
  plan?: string;            // optional plan markdown
  terminalId: number;       // which PTY to attach to (0-7)
  env?: Record<string, string>;
}

interface AgentProcess {
  processId: string;
  ptyId: number;
  onOutput: (data: Uint8Array) => void;
  onExit: (code: number) => void;
}

type AgentCapability = 'generate-plan' | 'execute-code' | 'review-code' | 'chat';
```

### 5.2 CLI Agent Implementation

1. Build prompt payload: concatenate ticket context + user prompt + plan into single string.
2. Spawn process: invoke agent CLI with payload. E.g., `claude --print --output-format stream-json -p {prompt}`
3. Pipe to PTY: stdout/stderr forwarded to xterm.js via Tauri events.
4. Capture output: parallel buffer captures all bytes. On exit, compressed with zstd → agent_logs.
5. Emit state change: on exit, ticket transitions running → review.

### 5.3 Default Agents

| Agent ID | Command Template | Notes |
|----------|-----------------|-------|
| claude-code | `claude --print --output-format stream-json -p {prompt}` | Primary |
| gemini-cli | `gemini -p {prompt}` | Google Gemini |
| codex-cli | `codex -p {prompt}` | OpenAI Codex |
| custom | `{command}` | User-defined |

## 6. UI Specification

Single-window, IDE-like layout. No tabs, no navigation, no page transitions. Dense but readable.

### 6.1 Layout

| Region | Default Width | Content |
|--------|--------------|---------|
| Left Panel | 300px (resizable, min 240, max 500) | Ticket list + detail/editor |
| Right Panel | Remaining space | Terminal grid (up to 8 tiles) |

### 6.2 Left Panel: Ticket Column

**List View (default):** Vertical scrolling card list. Each card: title, status badge (color-coded), priority, assigned agent, tags, timestamp. Sorted by: status weight (running > review > queued > ready > draft) then updated_at desc. "New Ticket" button pinned at top.

**Detail View (on card click):** Full ticket editor replacing the list. Fields: title, context (Markdown), prompt, plan (Markdown), repo path, tags (chips), priority, assigned agent (dropdown when status = ready). Back arrow returns to list. Status action button at bottom shows next valid transition.

### 6.3 Right Panel: Terminal Grid

Up to 8 terminal tiles. Each is an independent xterm.js instance connected to a Rust PTY.

**Layout Modes (auto-adjust):**

| Active Terminals | Layout |
|-----------------|--------|
| 1 | Single full-panel |
| 2 | 2 columns × 1 row |
| 3–4 | 2 columns × 2 rows |
| 5–6 | 3 columns × 2 rows |
| 7–8 | 4 columns × 2 rows |

Only active tiles shown. Empty slots collapsed.

**Tile Anatomy:**
- **Header (24px):** Ticket title (truncated), agent name, status badge, duration timer, maximize button, abort button.
- **Body:** xterm.js. Full ANSI color. 10,000-line scrollback. Connected to PTY via Tauri events.
- **Footer (20px):** Live token count, estimated cost, PID.

**Interactions:**
- Click header → focus (highlighted border)
- Double-click header → maximize/restore
- Cmd+1 through Cmd+8 → focus specific tile
- When ticket enters `review`, terminal becomes read-only. Header shows Approve/Reject/View Diff.

### 6.4 Global Elements

- **Title bar:** Native Tauri. App name + gear icon for Settings.
- **Settings panel:** Slide-over from right. Agent config, general prefs, keybindings.
- **Status bar (28px, bottom):** Running agent count, session cost, DB size.
- **Theme:** Dark mode only. BG #0F0F12, surface #1A1A22, border #2A2A35, text #E0E0E8, accent #3B82F6.

## 7. Terminal & PTY Bridge

### 7.1 Architecture

1. **PTY Pool:** Rust backend maintains up to 8 PTY instances via `portable-pty`. Slot IDs 0–7.
2. **Event Streaming:** Each PTY emits output via Tauri event `pty:output:{slot}`. Frontend subscribes per tile.
3. **Input Forwarding:** User keyboard input sent via Tauri command `write_to_pty(slot, data)`.
4. **Output Capture:** Background Rust task tees output into ring buffer (128MB max/slot). On exit, compressed with zstd → agent_logs.

### 7.2 Tauri Commands

| Command | Parameters | Returns |
|---------|-----------|---------|
| spawn_agent | slot: u8, command: String, args: Vec<String>, cwd: String, env: HashMap | process_id: String |
| write_to_pty | slot: u8, data: Vec<u8> | () |
| resize_pty | slot: u8, cols: u16, rows: u16 | () |
| kill_process | slot: u8 | exit_code: i32 |
| get_output_buffer | slot: u8 | Vec<u8> (compressed) |

### 7.3 Tauri Events

| Event | Payload | Description |
|-------|---------|-------------|
| pty:output:{slot} | { data: number[] } | Raw terminal output bytes |
| pty:exit:{slot} | { code: number, ticketId: string } | Process exited |
| ticket:state-change | { ticketId: string, from: string, to: string } | State transitioned |

## 8. Git Worktree Management

### Lifecycle

1. **Creation (ready → queued):** `git worktree add -b mozzie/{ticket_id} ~/.mozzie/worktrees/{ticket_id}/ <source_branch>`
2. **Execution (running):** Agent CWD set to worktree path. Scoped access only.
3. **Review:** Diff via `git diff <source_branch>...mozzie/{ticket_id}`
4. **Merge (review → done):** `git merge mozzie/{ticket_id}` on source branch.
5. **Cleanup (reject or done):** `git worktree remove <path>` + `git branch -D mozzie/{ticket_id}`

## 9. Output Capture & Review

### What Gets Captured
- **Terminal output:** Full raw byte stream, zstd compressed. Enables replay.
- **Git diff:** Text diff between source and worktree branch.
- **Metadata:** Duration, exit code, token counts, estimated cost.
- **Agent summary:** Parsed from structured output if available.

### Review UI
When ticket is in `review` state, detail view shows: terminal replay (scrollable, read-only), diff viewer (syntax-highlighted), execution stats, Approve/Reject buttons.

## 10. Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State mgmt | Zustand (UI) + TanStack Query (data) | Minimal + good cache invalidation |
| Terminal | xterm.js + webgl addon | Industry standard, GPU-accelerated |
| PTY | portable-pty | Cross-platform, used by Warp/Alacritty |
| Database | SQLite via tauri-plugin-sql | Zero setup, local-first |
| Compression | zstd | Best ratio for terminal output |
| IDs | ULID | Sortable by time, no coordination needed |
| Git ops | std::process::Command | More reliable than libgit2 for worktrees |
| CSS | Tailwind CSS | Utility-first, no runtime |
| Components | shadcn/ui | Accessible, owns source |
| Markdown editor | TipTap or Milkdown | Rich-text MD with extension support |
