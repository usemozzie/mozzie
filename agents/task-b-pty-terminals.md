# Task B: PTY Bridge & Terminal Grid

You are an AI coding agent responsible for ONE task: building the PTY management system in Rust and the terminal grid UI in React. Read `docs/SPEC.md` Sections 6.3 and 7 thoroughly before writing any code.

## Prerequisites

Task A must be complete. Verify by running:
```bash
ls apps/desktop/src-tauri/src/pty/mod.rs  # Should exist (empty stub)
ls packages/agent-sdk/src/types.ts         # Should exist with interfaces
pnpm tauri dev                             # Should open a window
```

If any of these fail, STOP. Do not proceed.

## Your Owned Files

You may ONLY create or edit files in these paths:
- `apps/desktop/src-tauri/src/pty/` (all files)
- `apps/desktop/src-tauri/src/commands/pty.rs`
- `apps/desktop/src/components/terminal/` (all files)
- `apps/desktop/src/hooks/useTerminal.ts`
- `apps/desktop/src/hooks/usePty.ts`

You may ALSO edit (append only — do not delete existing content):
- `apps/desktop/src-tauri/src/lib.rs` — replace the stub command registrations for PTY commands with your real implementations
- `apps/desktop/src-tauri/Cargo.toml` — add dependencies if needed
- `apps/desktop/package.json` — add frontend dependencies if needed

## Step-by-Step Deliverables

### 1. Rust PTY Pool (`src-tauri/src/pty/`)

Create `src-tauri/src/pty/mod.rs` and `src-tauri/src/pty/pool.rs`:

**PtyPool struct:**
- Manages up to 8 PTY slots (0–7)
- Uses `portable_pty` crate to spawn PTY instances
- Each slot holds: `Option<PtySlot>` where PtySlot contains the child process, master PTY handle, and a shared output buffer
- Thread-safe: wrap in `Arc<Mutex<>>` or use Tauri's state management

**PtySlot struct:**
```rust
struct PtySlot {
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn std::io::Write + Send>,
    process_id: String,  // ULID
    ticket_id: Option<String>,
    output_buffer: Arc<Mutex<Vec<u8>>>,  // Ring buffer, max 128MB
    active: bool,
}
```

**Key behaviors:**
- `spawn(slot: u8, command: &str, args: &[String], cwd: &str, env: HashMap<String, String>) -> Result<String>`: Creates a PTY with default size 80×24, spawns the command, starts a background tokio task that reads from the PTY master and:
  1. Emits a Tauri event `pty:output:{slot}` with the raw bytes
  2. Appends bytes to the output_buffer
  Returns the process_id (ULID).

- `write(slot: u8, data: &[u8]) -> Result<()>`: Writes to the PTY master (for user keyboard input).

- `resize(slot: u8, cols: u16, rows: u16) -> Result<()>`: Resizes the PTY.

- `kill(slot: u8) -> Result<i32>`: Kills the child process, waits for exit code, emits `pty:exit:{slot}`, compresses the output_buffer with zstd, marks slot as inactive. Returns exit code.

- `get_output(slot: u8) -> Result<Vec<u8>>`: Returns the zstd-compressed output buffer.

### 2. Tauri Commands (`src-tauri/src/commands/pty.rs`)

Implement the 5 Tauri commands that wrap the PtyPool:

```rust
#[tauri::command]
async fn spawn_agent(
    slot: u8,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    state: tauri::State<'_, PtyPoolState>,
    app: tauri::AppHandle,
) -> Result<String, String> { ... }

#[tauri::command]
async fn write_to_pty(slot: u8, data: Vec<u8>, state: ...) -> Result<(), String> { ... }

#[tauri::command]
async fn resize_pty(slot: u8, cols: u16, rows: u16, state: ...) -> Result<(), String> { ... }

#[tauri::command]
async fn kill_process(slot: u8, state: ...) -> Result<i32, String> { ... }

#[tauri::command]
async fn get_output_buffer(slot: u8, state: ...) -> Result<Vec<u8>, String> { ... }
```

Register the PtyPool as managed Tauri state in `lib.rs`. Replace the stub registrations with your real command functions.

### 3. React Terminal Grid (`src/components/terminal/`)

**`TerminalGrid.tsx`:**
- Receives `activeSlots: number[]` (which slots have active processes)
- Computes layout based on active count (see Section 6.3.1 of spec):
  - 1: single full panel
  - 2: 2×1 grid
  - 3–4: 2×2 grid
  - 5–6: 3×2 grid
  - 7–8: 4×2 grid
- Renders a CSS grid of `TerminalTile` components
- Only renders tiles for active slots; empty slots are not shown
- Handles maximize state: when a tile is maximized, only that tile renders (full size)

**`TerminalTile.tsx`:**
- Props: `slot: number`, `ticketTitle: string`, `agentName: string`, `status: string`, `isMaximized: boolean`, `isFocused: boolean`, `onFocus`, `onMaximize`, `onAbort`
- Structure:
  - Header bar (h-6): ticket title (truncated), agent badge, status badge, timer, maximize/restore button, abort button (red, only when running)
  - Body: div ref for xterm.js mount
  - Footer bar (h-5): token count, cost, PID
- Styling: dark theme per spec. Focused tile gets a blue border (`accent` color). Header uses `surface` background.

**`useXterm.ts` hook:**
- Takes a `containerRef` and `slot` number
- Creates an xterm.js Terminal instance with:
  - `theme`: colors matching spec dark theme
  - `fontFamily`: 'JetBrains Mono, Menlo, monospace'
  - `fontSize`: 13
  - `scrollback`: 10000
  - `cursorBlink`: true
- Attaches `FitAddon` and `WebglAddon`
- On mount: opens terminal in container, fits to container size
- Returns the terminal instance and a `fitToContainer()` function

### 4. React Hooks (`src/hooks/`)

**`usePty.ts`:**
- `useSpawnAgent(slot, command, args, cwd, env)`: Invokes the `spawn_agent` Tauri command. Returns `{ spawn, processId, isSpawning }`.
- `useKillProcess(slot)`: Invokes `kill_process`. Returns `{ kill, exitCode, isKilling }`.
- `useWriteToPty(slot)`: Returns a `write(data: Uint8Array)` function that invokes the Tauri command.
- `useResizePty(slot)`: Returns a `resize(cols, rows)` function.

**`useTerminal.ts`:**
- Combines `useXterm` and `usePty` for a specific slot
- Sets up the Tauri event listener for `pty:output:{slot}` — writes incoming data to xterm
- Sets up the Tauri event listener for `pty:exit:{slot}` — emits a callback
- Sets up xterm's `onData` handler to pipe user input to `useWriteToPty`
- Handles ResizeObserver on the container to call `fitAddon.fit()` and `useResizePty`
- Cleans up all listeners on unmount
- Returns: `{ containerRef, terminal, isActive, spawn, kill }`

### 5. Test the Integration

Create a temporary test in `main.tsx` (or a test component) that:
1. Renders the TerminalGrid with 4 active slots
2. Each slot spawns a simple bash shell (`/bin/bash` on macOS)
3. Verify: typing in one tile does NOT affect others
4. Verify: resize the window and terminals re-fit
5. Verify: kill a process and the tile updates

After testing, revert `main.tsx` to the minimal state (other agents need it clean).

## Completion Criteria

- [ ] PtyPool manages 8 independent PTY slots
- [ ] All 5 Tauri commands work and are registered
- [ ] Tauri events (`pty:output`, `pty:exit`) fire correctly
- [ ] TerminalGrid renders correct layout for 1–8 active terminals
- [ ] xterm.js instances display real terminal output with ANSI colors
- [ ] User can type in terminals and input reaches the PTY
- [ ] Window resize causes terminals to re-fit
- [ ] Output buffer captures all bytes and compresses with zstd on exit
- [ ] Maximize/restore works on individual tiles
- [ ] No memory leaks: killing a process cleans up its slot fully

## DO NOT

- Create or modify any ticket-related code (Task C)
- Create or modify any agent orchestration code (Task D)
- Modify `packages/db/` or `packages/agent-sdk/` (Task A owns these)
- Implement git worktree logic (Task D)
- Change the dark theme colors (use what Task A configured)
