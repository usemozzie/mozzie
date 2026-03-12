# Agent Panel Conversation Resume Spec

## Goal

Make the work item agent panel behave like a resumeable terminal chat:

- A work item must be explicitly started before the agent panel can send chat.
- The first start uses the work item context to open the agent session.
- Follow-up messages from the agent panel send only the user's message into the
  existing live session when one exists.
- Follow-up messages must not rebuild the work item prompt, re-inject attempt
  history, or restart the work item like a brand-new run.
- If the live session is gone but the work item already has prior chat history,
  the app should resume that conversation automatically before sending the new
  follow-up.

## Current Behavior

- `startAgent` creates or reuses the worktree, launches the agent, and marks the
  work item as running.
- Agent panel follow-ups call `continue_agent`.
- `continue_agent` rebuilds the prompt from `context` / `execution_context`,
  appends the follow-up text, and will create a new session if one is missing.
- The agent panel is currently enabled whenever the work item has an assigned
  agent and a `worktree_path`, even if no session has been explicitly started.
- ACP session state is in-memory only, so yesterday's work cannot be resumed
  from a still-open session after an app restart.

## Target Behavior

### Explicit start

- Play button, orchestrator start actions, and dependency auto-launch continue to
  use the existing `startAgent` flow.
- That flow remains responsible for creating or refreshing the worktree and
  branch before the first turn.

### Durable conversation gating

- Brand-new work items still require an explicit first start.
- Once a work item has prior agent conversation history, the agent panel remains
  usable even when no live ACP session is currently open.
- If there is prior history but no live session, sending a message should resume
  the conversation automatically.

### Raw follow-up messaging

- Follow-up chat uses the existing ACP session handle for the work item.
- The backend records a new agent log for the follow-up message, but the prompt
  sent to the agent is only the follow-up message text.
- No work item context, execution context, file reference expansion, or attempt
  history is appended during agent-panel follow-ups.
- If the session is already running, the in-flight turn is cancelled before the
  next follow-up message is sent, matching the current behavior.

### Resume behavior

- Persist a durable work-item conversation thread separate from the live ACP
  session.
- Seed that durable thread on first start using the initial work-item prompt.
- Persist user follow-up messages and assistant replies after each turn.
- When no live session exists but the work item has prior conversation history,
  create a fresh ACP session behind the scenes and resume from the persisted
  transcript plus the current worktree state.
- Only work items with no prior conversation history should be blocked from
  agent-panel chat.

## Implementation Notes

### Backend

- Keep `launch_agent` unchanged for first-start behavior.
- Add durable per-work-item chat history storage.
- Change `continue_agent` so it:
  - uses the live session directly when one exists,
  - otherwise resumes from durable work-item chat history,
  - inserts a fresh agent log,
  - sends only the raw follow-up message on live sessions,
  - uses a transcript-based resume prompt only when the live session is gone.

### Frontend

- Gate first-ever chat on prior start/history instead of only `session != null`.
- Allow chat for previously-started work items even after app restart.
- Reuse a terminal slot only for active follow-up execution.
- Update placeholder and inline error copy to direct the user toward explicitly
  starting a brand-new work item, while making prior work items feel like
  resumeable terminal chats.
- Render persisted user follow-up messages in the transcript so resumed chats
  read like one continuous terminal conversation.
- Do not allow changing the assigned agent once a work item already has durable
  conversation history.

## Acceptance Criteria

- A newly created work item with a repo and agent but no prior conversation
  history cannot
  send from the agent panel.
- Starting the work item opens a session and enables the composer.
- A follow-up message sent while the session is open reaches the agent without
  reusing `context` / `execution_context`.
- A follow-up message sent after app restart or session timeout resumes the
  prior work-item conversation instead of forcing a brand-new start.
- Play button, orchestrator starts, and dependency auto-launch still produce the
  same first-run behavior as before.
