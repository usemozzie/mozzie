# Task D: Agent Orchestration, Git Worktree & Final Integration

You are an AI coding agent responsible for the FINAL task: connecting tickets to terminals via agents, implementing git worktree management, building the review UI, and assembling the complete app layout. Read `docs/SPEC.md` Sections 5, 8, 9, and 10.4 thoroughly before writing any code.

## Prerequisites

Tasks A, B, AND C must ALL be complete. Verify:
```bash
# Task A artifacts
ls packages/agent-sdk/src/types.ts
ls packages/db/src/schema.ts

# Task B artifacts
ls apps/desktop/src-tauri/src/pty/pool.rs
ls apps/desktop/src/components/terminal/TerminalGrid.tsx
ls apps/desktop/src/hooks/useTerminal.ts

# Task C artifacts  
ls apps/desktop/src-tauri/src/commands/tickets.rs
ls apps/desktop/src/components/tickets/TicketPanel.tsx
ls apps/desktop/src/stores/ticketStore.ts
ls apps/desktop/src/stores/terminalStore.ts

# Full build works
pnpm tauri dev
```

If ANY of these fail, STOP. Do not proceed.

## Your Owned Files

You may ONLY create or edit files in these paths:
- `apps/desktop/src-tauri/src/commands/agents.rs`
- `apps/desktop/src-tauri/src/commands/worktree.rs`
- `apps/desktop/src-tauri/src/agents/` (all files)
- `apps/desktop/src/components/review/` (all files)
- `apps/desktop/src/components/settings/` (all files)
- `apps/desktop/src/App.tsx` (FINAL layout assembly)
- `apps/desktop/src/hooks/useAgents.ts`
- `apps/desktop/src/hooks/useWorktree.ts`
- `apps/desktop/src/hooks/useReview.ts`
- `packages/agent-sdk/src/runner.ts`
- `packages/agent-sdk/src/cli-runner.ts`

You may ALSO edit (carefully — do not break existing functionality):
- `apps/desktop/src-tauri/src/lib.rs` — replace remaining stub commands with real implementations
- `apps/desktop/src/stores/terminalStore.ts` — add agent tracking fields if needed
- `apps/desktop/src/components/tickets/TicketDetail.tsx` — wire up the action buttons to your orchestration logic

## Step-by-Step Deliverables

### 1. Git Worktree Commands (`src-tauri/src/commands/worktree.rs`)

Implement Tauri commands for git worktree management. All commands use `std::process::Command` to invoke git CLI directly.

**`create_worktree`**
- Params: `ticket_id: String, repo_path: String, source_branch: Option<String>`
- If `source_branch` is None, detect the current branch via `git rev-parse --abbrev-ref HEAD`
- Branch name: `mozzie/{ticket_id}`
- Worktree path: `~/.mozzie/worktrees/{ticket_id}/`
- Creates parent dirs if needed
- Runs: `git -C {repo_path} worktree add -b {branch_name} {worktree_path} {source_branch}`
- Returns: `{ worktree_path: String, branch_name: String }`
- On error: returns descriptive message (e.g., "Worktree already exists", "Not a git repository")

**`remove_worktree`**
- Params: `ticket_id: String, repo_path: String`
- Runs: `git -C {repo_path} worktree remove ~/.mozzie/worktrees/{ticket_id}/ --force`
- Then: `git -C {repo_path} branch -D mozzie/{ticket_id}` (ignore error if branch doesn't exist)
- Returns: `()`

**`get_diff`**
- Params: `ticket_id: String, repo_path: String, source_branch: String`
- Runs: `git -C {repo_path} diff {source_branch}...mozzie/{ticket_id} --stat` for summary
- Runs: `git -C {repo_path} diff {source_branch}...mozzie/{ticket_id}` for full diff
- Returns: `{ summary: String, full_diff: String, files_changed: Vec<String> }`

**`merge_worktree`**
- Params: `ticket_id: String, repo_path: String, source_branch: String`
- Runs: `git -C {repo_path} checkout {source_branch}`
- Runs: `git -C {repo_path} merge mozzie/{ticket_id} --no-ff -m "Mozzie: merge {ticket_id}"`
- If merge conflicts: returns error with conflict file list
- On success: calls `remove_worktree` to clean up
- Returns: `{ merged: bool, message: String }`

### 2. Agent Orchestration (`src-tauri/src/agents/`)

**`src-tauri/src/agents/mod.rs`** and **`src-tauri/src/agents/orchestrator.rs`:**

The orchestrator is the glue between tickets, worktrees, and terminals.

**`prepare_and_run` function:**
This is the main entry point. It orchestrates the full flow when a user clicks "Run" on a queued ticket:

1. **Read ticket** from SQLite by ID
2. **Validate** status is `queued`, has `assigned_agent`, `terminal_slot`, `repo_path`
3. **Create worktree** via `create_worktree` command (if not already created)
4. **Update ticket** with `worktree_path` and `branch_name`
5. **Build the prompt payload:**
   ```
   # Task
   {ticket.title}
   
   # Context
   {ticket.context}
   
   # Instructions  
   {ticket.prompt}
   
   # Plan
   {ticket.plan}  (if present)
   
   # Working Directory
   {ticket.worktree_path}
   ```
6. **Look up agent config** from agent_config table by `assigned_agent`
7. **Build command:** replace `{prompt}` in the agent's command template with the payload (write to a temp file for long prompts, pass as `@/tmp/mozzie-{ticket_id}.md`)
8. **Spawn via PTY:** call `spawn_agent` on the assigned terminal slot with the built command, working dir = worktree_path
9. **Transition ticket** to `running`
10. **Record start time**

**`handle_exit` function:**
Called when a `pty:exit` event fires for a slot that has a ticket:

1. **Get exit code** and compressed output buffer from PTY pool
2. **Create agent_log entry** with: ticket_id, agent_id, output (compressed), exit_code, duration (now - started_at), tokens parsed from output (if possible)
3. **Transition ticket** to `review`
4. **Emit** a `ticket:review-ready` event to the frontend

**Tauri command: `run_ticket`**
- Params: `ticket_id: String`
- Calls `prepare_and_run`
- Returns success or descriptive error

**Tauri command: `abort_ticket`**
- Params: `ticket_id: String`
- Looks up the terminal slot from the ticket
- Calls `kill_process` on that slot
- Transitions ticket back to `ready`
- Cleans up worktree
- Returns: `()`

**Tauri command: `approve_ticket`**
- Params: `ticket_id: String`
- Calls `merge_worktree`
- Transitions ticket to `done`
- Returns merge result

**Tauri command: `reject_ticket`**
- Params: `ticket_id: String`
- Calls `remove_worktree`
- Transitions ticket to `ready` (clears agent, slot, worktree fields)
- Returns: `()`

### 3. Agent Config Commands (`src-tauri/src/commands/agents.rs`)

**`list_agent_configs`**: Returns all agent configs from SQLite.

**`upsert_agent_config`**: Insert or update an agent config row.

**`delete_agent_config`**: Delete by ID. Prevent deleting if any running ticket uses this agent.

### 4. Frontend: Agent SDK Implementation (`packages/agent-sdk/src/`)

**`runner.ts`:**
```typescript
export interface AgentRunnerFrontend {
  runTicket(ticketId: string): Promise<void>;
  abortTicket(ticketId: string): Promise<void>;
  approveTicket(ticketId: string): Promise<MergeResult>;
  rejectTicket(ticketId: string): Promise<void>;
}
```

Implement using Tauri `invoke()` calls to the commands above.

### 5. Frontend: React Hooks (`src/hooks/`)

**`useAgents.ts`:**
- `useAgentConfigs()`: TanStack Query fetching agent configs.
- `useRunTicket()`: Mutation calling `run_ticket`.
- `useAbortTicket()`: Mutation calling `abort_ticket`.
- `useApproveTicket()`: Mutation calling `approve_ticket`. Invalidates tickets on success.
- `useRejectTicket()`: Mutation calling `reject_ticket`. Invalidates tickets on success.

**`useWorktree.ts`:**
- `useDiff(ticketId)`: Calls `get_diff` when ticket is in `review` state.

**`useReview.ts`:**
- `useAgentLog(ticketId)`: Fetches the most recent agent log for a ticket.

### 6. Review UI (`src/components/review/`)

**`ReviewPanel.tsx`:**
- Shown when a ticket in `review` state is selected in the detail view
- Replaces the normal editor fields with a review interface
- Layout (vertical stack):
  1. **Header:** Ticket title, agent name, duration, cost
  2. **Tab bar:** "Output" | "Diff" | "Stats"
  3. **Content area** (based on selected tab):
     - **Output tab:** Scrollable pre-formatted terminal output. Render the raw output with ANSI-to-HTML conversion (use `ansi-to-html` npm package). Read-only.
     - **Diff tab:** Syntax-highlighted unified diff. Use a simple diff renderer (color code +/- lines). Show file-by-file with collapsible sections.
     - **Stats tab:** Exit code, duration, tokens in/out, cost, agent ID, timestamp
  4. **Action bar (bottom):** "Approve & Merge" (green button), "Reject & Retry" (red outline button)

**`DiffViewer.tsx`:**
- Takes a unified diff string
- Parses into file sections
- Renders with: file headers (bold), added lines (green bg), removed lines (red bg), context lines (default)
- Collapsible per file

### 7. Settings Panel (`src/components/settings/`)

**`SettingsPanel.tsx`:**
- Slide-over panel from the right edge (triggered by gear icon in title bar)
- Uses a semi-transparent overlay backdrop
- Sections:
  1. **Agents:** List of configured agents. Each row: display name, type badge, command preview, enabled toggle. "Add Agent" button at bottom. Click a row to edit.
  2. **Agent Editor** (inline expandable): Fields for all AgentConfig columns. Save/Cancel buttons.
  3. **General:** Default repo path (text input + browse), Theme (dark only for now, disabled toggle).

### 8. Final Layout Assembly (`src/App.tsx`)

This is where you assemble everything. Create the complete app layout:

```tsx
// Pseudocode structure
<QueryClientProvider>
  <div className="h-screen w-screen flex flex-col bg-bg text-text">
    {/* Title Bar Area */}
    <header className="h-10 flex items-center justify-between px-4 border-b border-border">
      <span className="font-semibold">Mozzie</span>
      <button onClick={openSettings}><GearIcon /></button>
    </header>
    
    {/* Main Content */}
    <PanelGroup direction="horizontal" className="flex-1">
      <Panel defaultSize={25} minSize={15} maxSize={40}>
        <TicketPanel />
      </Panel>
      <PanelResizeHandle className="w-1 bg-border hover:bg-accent transition-colors" />
      <Panel>
        <TerminalGrid />
      </Panel>
    </PanelGroup>
    
    {/* Status Bar */}
    <footer className="h-7 flex items-center px-4 border-t border-border text-xs text-gray-500">
      <span>{runningCount} agents running</span>
      <span className="ml-auto">Session cost: ${totalCost}</span>
    </footer>
    
    {/* Settings Overlay */}
    {settingsOpen && <SettingsPanel onClose={closeSettings} />}
  </div>
</QueryClientProvider>
```

Wire up:
- TicketPanel action buttons → your orchestration hooks (runTicket, abortTicket, approveTicket, rejectTicket)
- TerminalGrid → reads from terminalStore to know which slots are active
- Status bar → aggregates data from active tickets and agent logs
- Settings gear → toggles settings panel

### 9. Wire Up the Full Flow

Test the complete end-to-end:
1. Create a ticket with title, context, and a valid repo path
2. Mark it ready
3. Assign claude-code agent and auto-select terminal slot
4. Queue it
5. Click Run → verify worktree is created, agent spawns in the correct terminal tile
6. Wait for agent to finish (or abort it)
7. Verify output is captured in agent_logs
8. Review: check Output, Diff, and Stats tabs
9. Approve → verify worktree is merged and cleaned up
10. Ticket moves to done

Also test the reject flow: reject from review, verify worktree cleanup, ticket returns to ready.

## Completion Criteria

- [ ] Git worktree create/remove/diff/merge all work correctly
- [ ] Agent orchestrator runs the full lifecycle: queue → run → capture → review
- [ ] `run_ticket` command spawns the correct agent CLI in the correct terminal slot with the correct working directory
- [ ] Output is captured, compressed, and stored in agent_logs on process exit
- [ ] Review UI shows terminal output, diff, and stats
- [ ] Approve merges the worktree branch and cleans up
- [ ] Reject cleans up the worktree and returns ticket to ready
- [ ] Abort kills the running process and cleans up
- [ ] Settings panel allows adding/editing/removing agents
- [ ] Final App.tsx layout matches the spec: left ticket panel, right terminal grid, status bar
- [ ] All stores and hooks are properly connected
- [ ] No orphaned worktrees after approve/reject/abort
- [ ] Session cost in status bar aggregates from agent_logs

## DO NOT

- Rewrite the PTY pool or terminal grid (Task B owns these)
- Rewrite the ticket CRUD or state machine (Task C owns these)
- Modify the database schema (Task A owns this)
- Add cloud/network features (Phase 2)
- Add Slack/webhook connectors (Phase 2)
- Skip the end-to-end test
