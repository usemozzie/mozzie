# Task C: Ticket System & Left Panel UI

You are an AI coding agent responsible for ONE task: building the ticket CRUD system, the state machine, and the left panel React UI. Read `docs/SPEC.md` Sections 3, 4, and 6.2 thoroughly before writing any code.

## Prerequisites

Task A must be complete. Verify by running:
```bash
ls packages/db/src/schema.ts               # Should exist with Ticket types
ls apps/desktop/src-tauri/migrations/       # Should contain 001_init.sql
pnpm tauri dev                              # Should open a window
```

If any of these fail, STOP. Do not proceed.

## Your Owned Files

You may ONLY create or edit files in these paths:
- `apps/desktop/src/components/tickets/` (all files)
- `apps/desktop/src/components/ui/` (shadcn components you need)
- `apps/desktop/src/stores/` (all files)
- `apps/desktop/src/hooks/useTickets.ts`
- `apps/desktop/src/hooks/useTicketMutation.ts`
- `apps/desktop/src-tauri/src/commands/tickets.rs`
- `packages/db/src/queries.ts` (you may extend the query helpers if needed)

You may ALSO edit (append only):
- `apps/desktop/src-tauri/src/lib.rs` — replace stub ticket commands with real implementations
- `apps/desktop/package.json` — add dependencies if needed

## Step-by-Step Deliverables

### 1. Rust Ticket Commands (`src-tauri/src/commands/tickets.rs`)

Implement these Tauri commands that operate on the SQLite database via `tauri-plugin-sql`:

**`create_ticket`**
- Params: `title: String, context: Option<String>, repo_path: Option<String>, priority: Option<String>, tags: Option<String>`
- Generates a ULID for `id`
- Sets `status = "draft"`, `created_at` and `updated_at` to ISO 8601 now
- Inserts into tickets table
- Returns the full Ticket as JSON

**`update_ticket`**
- Params: `id: String, fields: serde_json::Value` (partial update)
- Only allows updating: `title`, `context`, `prompt`, `plan`, `repo_path`, `tags`, `priority`, `assigned_agent`, `terminal_slot`
- Updates `updated_at` to now
- Validates: cannot update a ticket in `running` state (return error)
- Returns updated Ticket

**`list_tickets`**
- Params: `status_filter: Option<Vec<String>>`
- Returns all tickets matching the filter (or all if no filter)
- Ordered by: status weight (running=0, review=1, queued=2, ready=3, draft=4, done=5, archived=6) then `updated_at` DESC
- Returns `Vec<Ticket>` as JSON

**`get_ticket`**
- Params: `id: String`
- Returns single Ticket or error

**`transition_ticket`**
- Params: `id: String, to_status: String`
- THIS IS THE MOST CRITICAL COMMAND. Implements the state machine:
  - Validates the transition is allowed (see Section 4 of spec)
  - Validates prerequisites:
    - `draft → ready`: title AND context AND repo_path must be non-null/non-empty
    - `ready → queued`: assigned_agent AND terminal_slot must be set
    - `queued → running`: sets `started_at` to now
    - `running → review`: sets `completed_at` to now
    - `review → done`: (no extra validation, merge happens in Task D)
    - `review → ready`: clears `assigned_agent`, `terminal_slot`, `started_at`, `completed_at`, `worktree_path`, `branch_name`
    - `done → archived`: no extra validation
  - Returns error with descriptive message if transition is invalid
  - Emits Tauri event `ticket:state-change` with `{ ticketId, from, to }`
  - Returns updated Ticket

**`archive_ticket`**
- Shortcut for transitioning to archived
- Only allowed from `done` state

Replace the stub command registrations in `lib.rs` with these real functions.

### 2. Zustand Stores (`src/stores/`)

**`ticketStore.ts`:**
```typescript
interface TicketStore {
  // View state
  selectedTicketId: string | null;
  viewMode: 'list' | 'detail';
  statusFilter: TicketStatus[];
  
  // Actions
  selectTicket: (id: string | null) => void;
  setViewMode: (mode: 'list' | 'detail') => void;
  setStatusFilter: (statuses: TicketStatus[]) => void;
  openTicketDetail: (id: string) => void;  // sets both selectedTicketId and viewMode
  backToList: () => void;  // clears selection, sets viewMode to list
}
```

**`terminalStore.ts`:**
```typescript
interface TerminalStore {
  // Track which slots are active and what ticket is in each
  activeSlots: Map<number, string>;  // slot → ticketId
  focusedSlot: number | null;
  maximizedSlot: number | null;
  
  // Actions
  assignSlot: (slot: number, ticketId: string) => void;
  releaseSlot: (slot: number) => void;
  focusSlot: (slot: number | null) => void;
  toggleMaximize: (slot: number) => void;
  getNextAvailableSlot: () => number | null;  // returns first unused slot 0-7
}
```

### 3. React Query Hooks (`src/hooks/`)

**`useTickets.ts`:**
- `useTickets(statusFilter?)`: Calls `list_tickets` Tauri command. Returns TanStack Query result. Refetches on `ticket:state-change` events.
- `useTicket(id)`: Calls `get_ticket`. Returns single ticket.

**`useTicketMutation.ts`:**
- `useCreateTicket()`: Mutation that calls `create_ticket`. Invalidates ticket list on success.
- `useUpdateTicket()`: Mutation that calls `update_ticket`. Invalidates ticket + list.
- `useTransitionTicket()`: Mutation that calls `transition_ticket`. Invalidates ticket + list. This is the most used mutation.

### 4. Left Panel Components (`src/components/tickets/`)

**`TicketPanel.tsx`:**
- The top-level left panel component
- Renders either `TicketList` or `TicketDetail` based on `viewMode` from store
- Has a fixed header with: "Tickets" title, "New Ticket" button (+ icon), filter dropdown (by status)
- Uses `react-resizable-panels` — this is the left `Panel` in a `PanelGroup`

**`TicketList.tsx`:**
- Renders a scrollable list of `TicketCard` components
- Uses `useTickets()` hook for data
- Shows loading skeleton while fetching
- Empty state: "No tickets yet. Create one to get started."
- Keyboard nav: Arrow up/down to move selection, Enter to open detail

**`TicketCard.tsx`:**
- Compact card component for the list view
- Shows: title (1 line, truncated), status badge (colored), priority indicator (colored dot), assigned agent name (if any), tags (chips, max 3 visible), relative timestamp ("2m ago")
- Click → opens detail view via store
- Highlight when selected
- Status badge colors:
  - draft: gray
  - ready: blue
  - queued: yellow
  - running: green (with pulse animation)
  - review: orange
  - done: emerald
  - archived: dim gray

**`TicketDetail.tsx`:**
- Full ticket editor view
- Header: back arrow button, ticket title (editable), status badge
- Form fields (all save on change with debounce 500ms via `useUpdateTicket`):
  - **Title**: text input, required
  - **Context**: Markdown editor (use TipTap with starter-kit). Large area, ~40% of panel height.
  - **Prompt**: text area, 3 lines. Placeholder: "Additional instructions for the agent..."
  - **Plan**: Markdown editor, collapsible section. Placeholder: "Execution plan (optional)..."
  - **Repo Path**: text input with a "Browse" button (uses Tauri's `dialog.open` for folder picker)
  - **Tags**: chip input. Type and press Enter to add. Click X to remove.
  - **Priority**: dropdown select (low/medium/high/urgent)
  - **Agent**: dropdown select, populated from `list_agent_configs` Tauri command. Only enabled when status = ready.
  - **Terminal Slot**: dropdown (0–7), only enabled when status = ready. Shows which slots are occupied (from terminalStore). Auto-selects next available.
- Footer: primary action button that changes based on status:
  - draft → "Mark Ready" (validates required fields first)
  - ready → "Queue for Execution" (requires agent + slot)
  - queued → "Run Agent" (spawns agent — this calls into Task D's code, so just emit the transition for now)
  - running → "Abort" (red button)
  - review → two buttons: "Approve & Merge" (green) + "Reject & Retry" (red)
  - done → "Archive"

**`StatusBadge.tsx`:**
- Reusable status badge component
- Props: `status: TicketStatus`
- Renders a small pill with the status text and appropriate color

**`PriorityDot.tsx`:**
- Small colored dot indicating priority
- low: gray, medium: blue, high: orange, urgent: red

### 5. Shadcn UI Components (`src/components/ui/`)

Add the shadcn components you need. Since we can't run the shadcn CLI, create them manually using the shadcn patterns (accessible, composable, Tailwind-styled):

- `Button.tsx` — with variants: default, destructive, outline, ghost
- `Input.tsx` — text input with dark theme
- `Select.tsx` — dropdown select
- `Badge.tsx` — for status/tag pills
- `Skeleton.tsx` — for loading states
- `ScrollArea.tsx` — for the ticket list scroll container

All components must use the dark theme colors from the spec. Background: `bg`, surface: `surface`, border: `border`, text: `text`, accent: `accent`.

### 6. Test the Integration

Create a temporary test flow:
1. Render the `TicketPanel` in `main.tsx` as the left side of a flex container
2. Create a ticket using the "New Ticket" button
3. Fill in title, context, repo path
4. Mark it as ready
5. Verify: the card in the list updates its status badge
6. Verify: the state machine rejects invalid transitions (e.g., draft → running)
7. Verify: keyboard navigation works in the list

After testing, revert `main.tsx` to a clean state that just renders the TicketPanel on the left and an empty div on the right (for Task D to assemble the final layout).

## Completion Criteria

- [ ] All 5 Tauri ticket commands work correctly
- [ ] State machine validates all transitions per spec Section 4
- [ ] Invalid transitions return descriptive error messages
- [ ] `ticket:state-change` events fire on every transition
- [ ] TicketList renders cards sorted by status weight then updated_at
- [ ] TicketDetail shows all fields and saves on change
- [ ] Status action button reflects correct next transition
- [ ] Required field validation works (draft → ready requires title + context + repo_path)
- [ ] Repo path file picker works via Tauri dialog
- [ ] TanStack Query refetches ticket list on state change events
- [ ] Keyboard navigation (arrows + enter + escape) works in list
- [ ] Dark theme matches spec colors exactly
- [ ] No console errors or warnings

## DO NOT

- Create or modify any PTY/terminal code (Task B)
- Implement agent spawning logic (Task D)
- Implement git worktree operations (Task D)
- Implement the review UI diff viewer (Task D)
- Modify `packages/agent-sdk/` (Task A owns this)
- Change the terminal store schema without coordinating with Task B
