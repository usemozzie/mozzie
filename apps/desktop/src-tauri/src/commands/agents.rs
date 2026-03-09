use agent_client_protocol::{
    Agent, CancelNotification, Client, ClientCapabilities, ClientSideConnection, ContentBlock,
    Error as AcpError, FileSystemCapability, Implementation, InitializeRequest, NewSessionRequest,
    PromptRequest, ProtocolVersion, ReadTextFileRequest, ReadTextFileResponse,
    RequestPermissionRequest, RequestPermissionResponse, RequestPermissionOutcome, Result as AcpResult,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason, WriteTextFileRequest,
    WriteTextFileResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{mpsc, oneshot},
    time::{timeout, Duration},
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use ulid::Ulid;

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub id: String,
    pub display_name: String,
    pub acp_url: String,
    pub api_key_ref: Option<String>,
    pub model: Option<String>,
    pub max_concurrent: i64,
    pub enabled: i64,
    pub strengths: Option<String>,
    pub weaknesses: Option<String>,
    pub best_for: Option<String>,
    pub reasoning_class: Option<String>,
    pub speed_class: Option<String>,
    pub edit_reliability: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AgentConfig {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(AgentConfig {
            id: row.try_get("id")?,
            display_name: row.try_get("display_name")?,
            acp_url: row.try_get("acp_url")?,
            api_key_ref: row.try_get("api_key_ref")?,
            model: row.try_get("model")?,
            max_concurrent: row.try_get("max_concurrent")?,
            enabled: row.try_get("enabled")?,
            strengths: row.try_get("strengths")?,
            weaknesses: row.try_get("weaknesses")?,
            best_for: row.try_get("best_for")?,
            reasoning_class: row.try_get("reasoning_class")?,
            speed_class: row.try_get("speed_class")?,
            edit_reliability: row.try_get("edit_reliability")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentLog {
    pub id: String,
    pub work_item_id: String,
    pub agent_id: String,
    pub run_id: Option<String>,
    pub messages: Option<String>, // JSON: Vec<AcpEventItem>
    pub summary: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub cost_usd: Option<f64>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub cleanup_warning: Option<i64>,
    pub cleanup_warning_message: Option<String>,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AgentLog {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(AgentLog {
            id: row.try_get("id")?,
            work_item_id: row.try_get("work_item_id")?,
            agent_id: row.try_get("agent_id")?,
            run_id: row.try_get("run_id")?,
            messages: row.try_get("messages")?,
            summary: row.try_get("summary")?,
            tokens_in: row.try_get("tokens_in")?,
            tokens_out: row.try_get("tokens_out")?,
            cost_usd: row.try_get("cost_usd")?,
            exit_code: row.try_get("exit_code")?,
            duration_ms: row.try_get("duration_ms")?,
            cleanup_warning: row.try_get("cleanup_warning")?,
            cleanup_warning_message: row.try_get("cleanup_warning_message")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

/// A single streamed event from an ACP run, stored in agent_logs.messages.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AcpEventItem {
    pub id: String,
    /// "text" | "text_delta" | "tool_call" | "tool_result" | "error" | "done"
    pub kind: String,
    pub content: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<String>,
    pub tool_call_id: Option<String>,
    pub ts: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermissionPolicy {
    Ask,
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentPermissionRequestState {
    pub request_id: String,
    pub tool_title: Option<String>,
    pub tool_kind: Option<String>,
    pub tool_input: Option<String>,
    pub options: Vec<AgentPermissionOption>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentSessionState {
    pub work_item_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub is_running: bool,
    pub opened_at: String,
    pub last_activity_at: String,
    pub idle_deadline_at: String,
    pub permission_policy: AgentPermissionPolicy,
    pub pending_permission: Option<AgentPermissionRequestState>,
}

struct PendingPermissionDecision {
    request_id: String,
    reply: oneshot::Sender<Option<String>>,
}

#[derive(Clone)]
struct SessionShared {
    app: AppHandle,
    work_item_id: String,
    agent_id: String,
    worktree_root: PathBuf,
    snapshot: Arc<Mutex<AgentSessionState>>,
    current_log_id: Arc<Mutex<Option<String>>>,
    turn_events: Arc<Mutex<Vec<AcpEventItem>>>,
    pending_permission: Arc<Mutex<Option<PendingPermissionDecision>>>,
}

impl SessionShared {
    fn snapshot(&self) -> AgentSessionState {
        self.snapshot
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| AgentSessionState {
                work_item_id: self.work_item_id.clone(),
                agent_id: self.agent_id.clone(),
                session_id: String::new(),
                is_running: false,
                opened_at: now_iso(),
                last_activity_at: now_iso(),
                idle_deadline_at: idle_deadline_iso(),
                permission_policy: AgentPermissionPolicy::AllowOnce,
                pending_permission: None,
            })
    }

    fn update_snapshot<F>(&self, update: F) -> AgentSessionState
    where
        F: FnOnce(&mut AgentSessionState),
    {
        let mut state = self
            .snapshot
            .lock()
            .expect("session snapshot lock poisoned");
        update(&mut state);
        state.clone()
    }

    fn emit_state(&self) {
        let state = self.snapshot();
        emit_session_state(&self.app, &self.work_item_id, Some(&state));
    }

    fn mark_activity(&self) {
        let now = now_iso();
        let deadline = idle_deadline_iso();
        let _ = self.update_snapshot(|state| {
            state.last_activity_at = now.clone();
            state.idle_deadline_at = deadline.clone();
        });
        self.emit_state();
    }

    fn current_log_id(&self) -> Option<String> {
        self.current_log_id
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn set_current_log_id(&self, log_id: Option<String>) {
        if let Ok(mut value) = self.current_log_id.lock() {
            *value = log_id;
        }
    }

    fn clear_turn_events(&self) {
        if let Ok(mut events) = self.turn_events.lock() {
            events.clear();
        }
    }

    fn take_turn_events(&self) -> Vec<AcpEventItem> {
        self.turn_events
            .lock()
            .map(|mut events| std::mem::take(&mut *events))
            .unwrap_or_default()
    }

    fn push_turn_event(&self, item: AcpEventItem) {
        if let Ok(mut events) = self.turn_events.lock() {
            events.push(item.clone());
        }
        if let Some(log_id) = self.current_log_id() {
            emit_acp_event(&self.app, &self.work_item_id, &log_id, &item);
        }
    }

    fn clear_pending_permission(&self) {
        if let Ok(mut pending) = self.pending_permission.lock() {
            if let Some(decision) = pending.take() {
                let _ = decision.reply.send(None);
            }
        }
        let _ = self.update_snapshot(|state| state.pending_permission = None);
        self.emit_state();
    }

    fn respond_to_permission(
        &self,
        request_id: &str,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_permission
            .lock()
            .map_err(|_| "Permission prompt is unavailable".to_string())?;
        let decision = pending
            .take()
            .ok_or_else(|| "No pending permission request".to_string())?;
        if decision.request_id != request_id {
            *pending = Some(decision);
            return Err("Permission request no longer matches the active prompt".to_string());
        }
        let _ = decision.reply.send(option_id);
        drop(pending);
        let _ = self.update_snapshot(|state| state.pending_permission = None);
        self.emit_state();
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct ActiveSessionHandle {
    pub(crate) slot: Arc<Mutex<u8>>,
    command_tx: mpsc::UnboundedSender<SessionCommand>,
    shared: SessionShared,
}

impl ActiveSessionHandle {
    pub(crate) fn current_slot(&self) -> Option<u8> {
        self.slot.lock().ok().map(|slot| *slot)
    }

    fn set_slot(&self, next_slot: u8) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = next_slot;
        }
    }
}

#[derive(Clone)]
pub struct ActiveSessions(pub Arc<Mutex<HashMap<String, ActiveSessionHandle>>>);

impl Default for ActiveSessions {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

enum SessionCommand {
    StartTurn {
        log_id: String,
        prompt: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    CancelTurn {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: Option<oneshot::Sender<Result<(), String>>>,
    },
    Touch,
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn idle_deadline_iso() -> String {
    (chrono::Utc::now() + chrono::Duration::seconds((15 * 60) as i64))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[derive(Clone)]
struct AcpClientHandler {
    shared: SessionShared,
}

impl AcpClientHandler {
    fn push_item(&self, item: AcpEventItem) {
        self.shared.push_turn_event(item);
    }

    fn validate_path(&self, path: &Path) -> AcpResult<()> {
        if !path.is_absolute() {
            return Err(AcpError::invalid_params().data("Path must be absolute"));
        }

        if !path.starts_with(&self.shared.worktree_root) {
            return Err(AcpError::invalid_params().data("Path is outside the worktree"));
        }

        Ok(())
    }
}

#[async_trait::async_trait(?Send)]
impl Client for AcpClientHandler {
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> AcpResult<RequestPermissionResponse> {
        let policy = self.shared.snapshot().permission_policy;
        let options = args
            .options
            .iter()
            .map(|option| AgentPermissionOption {
                option_id: option.option_id.to_string(),
                name: option.name.clone(),
                kind: format!("{:?}", option.kind),
            })
            .collect::<Vec<_>>();

        let option_id = match policy {
            AgentPermissionPolicy::Ask => None,
            AgentPermissionPolicy::AllowOnce => args
                .options
                .iter()
                .find(|option| {
                    let kind = format!("{:?}", option.kind).to_lowercase();
                    kind.contains("allow_once") || kind.contains("allowonce")
                })
                .map(|option| option.option_id.clone()),
            AgentPermissionPolicy::AllowAlways => args
                .options
                .iter()
                .find(|option| {
                    let kind = format!("{:?}", option.kind).to_lowercase();
                    kind.contains("allow_always") || kind.contains("allowalways")
                })
                .map(|option| option.option_id.clone()),
            AgentPermissionPolicy::RejectOnce => args
                .options
                .iter()
                .find(|option| {
                    let kind = format!("{:?}", option.kind).to_lowercase();
                    kind.contains("reject_once") || kind.contains("rejectonce")
                })
                .map(|option| option.option_id.clone()),
            AgentPermissionPolicy::RejectAlways => args
                .options
                .iter()
                .find(|option| {
                    let kind = format!("{:?}", option.kind).to_lowercase();
                    kind.contains("reject_always") || kind.contains("rejectalways")
                })
                .map(|option| option.option_id.clone()),
        };

        if let Some(option_id) = option_id {
            return Ok(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
            ));
        }

        let request_id = Ulid::new().to_string();
        let request = AgentPermissionRequestState {
            request_id: request_id.clone(),
            tool_title: args.tool_call.fields.title.clone(),
            tool_kind: args
                .tool_call
                .fields
                .kind
                .as_ref()
                .map(|kind| format!("{kind:?}")),
            tool_input: args
                .tool_call
                .fields
                .raw_input
                .as_ref()
                .map(|value| value.to_string()),
            options,
            created_at: now_iso(),
        };
        let (reply_tx, reply_rx) = oneshot::channel();

        if let Ok(mut pending) = self.shared.pending_permission.lock() {
            *pending = Some(PendingPermissionDecision {
                request_id: request_id.clone(),
                reply: reply_tx,
            });
        }

        let _ = self.shared.update_snapshot(|state| {
            state.pending_permission = Some(request.clone());
        });
        self.shared.emit_state();

        match reply_rx.await {
            Ok(Some(option_id)) => Ok(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
            )),
            _ => Ok(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            )),
        }
    }

    async fn session_notification(&self, args: SessionNotification) -> AcpResult<()> {
        if let Some(item) = map_session_update(&args.update) {
            self.push_item(item);
        }
        Ok(())
    }

    async fn write_text_file(&self, args: WriteTextFileRequest) -> AcpResult<WriteTextFileResponse> {
        self.validate_path(&args.path)?;

        if let Some(parent) = args.path.parent() {
            std::fs::create_dir_all(parent).map_err(AcpError::into_internal_error)?;
        }

        std::fs::write(&args.path, args.content).map_err(AcpError::into_internal_error)?;
        self.push_item(AcpEventItem {
            id: Ulid::new().to_string(),
            kind: "tool_result".to_string(),
            content: Some(format!("Wrote {}", args.path.display())),
            tool_name: Some("fs.write_text_file".to_string()),
            tool_input: None,
            tool_call_id: None,
            ts: now_iso(),
        });

        Ok(WriteTextFileResponse::new())
    }

    async fn read_text_file(&self, args: ReadTextFileRequest) -> AcpResult<ReadTextFileResponse> {
        self.validate_path(&args.path)?;

        let content = std::fs::read_to_string(&args.path).map_err(AcpError::into_internal_error)?;
        let content = slice_file_content(&content, args.line, args.limit);

        Ok(ReadTextFileResponse::new(content))
    }
}

fn slice_file_content(content: &str, line: Option<u32>, limit: Option<u32>) -> String {
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    let max_lines = limit.unwrap_or(u32::MAX) as usize;

    content
        .lines()
        .skip(start)
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

fn map_session_update(update: &SessionUpdate) -> Option<AcpEventItem> {
    let (kind, content, tool_name, tool_input, tool_call_id) = match update {
        SessionUpdate::AgentMessageChunk(chunk) => (
            "text",
            Some(render_content_block(&chunk.content)),
            None,
            None,
            None,
        ),
        SessionUpdate::AgentThoughtChunk(chunk) => (
            "text_delta",
            Some(render_content_block(&chunk.content)),
            None,
            None,
            None,
        ),
        SessionUpdate::ToolCall(tool) => (
            "tool_call",
            Some(tool.title.clone()),
            Some(format!("{:?}", tool.kind)),
            tool.raw_input.as_ref().map(|value| value.to_string()),
            Some(tool.tool_call_id.to_string()),
        ),
        SessionUpdate::ToolCallUpdate(update) => (
            "tool_result",
            update
                .fields
                .title
                .clone()
                .or_else(|| update.fields.status.as_ref().map(|status| format!("{status:?}"))),
            Some("tool.update".to_string()),
            update.fields.raw_output.as_ref().map(|value| value.to_string()),
            Some(update.tool_call_id.to_string()),
        ),
        SessionUpdate::Plan(plan) => (
            "text",
            Some(
                plan.entries
                    .iter()
                    .map(|entry| format!("- {:?}: {}", entry.status, entry.content))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            None,
            None,
            None,
        ),
        _ => return None,
    };

    Some(AcpEventItem {
        id: Ulid::new().to_string(),
        kind: kind.to_string(),
        content,
        tool_name,
        tool_input,
        tool_call_id,
        ts: now_iso(),
    })
}

fn render_content_block(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "<non-text content>".to_string()),
    }
}

/// Extract explicit file references using the `@file:path/to/file.ext` syntax.
/// Bare `@path` is NOT treated as a file reference because execution contexts are full
/// of npm scoped packages (`@testing-library/jest-dom`), import aliases (`@/components/...`),
/// and other `@`-prefixed tokens that are not file references.
fn extract_file_references(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let prefix = "@file:";

    let mut search_from = 0;
    while let Some(pos) = text[search_from..].find(prefix) {
        let abs_pos = search_from + pos + prefix.len();
        let mut end = abs_pos;
        let chars: Vec<char> = text[abs_pos..].chars().collect();

        for &ch in &chars {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '\\') {
                end += ch.len_utf8();
            } else {
                break;
            }
        }

        if end > abs_pos {
            let candidate = text[abs_pos..end]
                .trim_end_matches(|c: char| c == '.' || c == '/')
                .to_string();
            if !candidate.is_empty() && !refs.contains(&candidate) {
                refs.push(candidate);
            }
        }

        search_from = end.max(abs_pos);
    }

    refs
}

fn expand_prompt_with_file_refs(prompt: &str, worktree_path: &str) -> Result<String, String> {
    const MAX_FILE_REFS: usize = 5;
    const MAX_FILE_BYTES: usize = 20_000;

    let refs = extract_file_references(prompt);
    if refs.is_empty() {
        return Ok(prompt.to_string());
    }

    let root = std::fs::canonicalize(worktree_path)
        .map_err(|err| format!("Failed to access selected repo/worktree: {err}"))?;

    let mut sections = Vec::new();

    for file_ref in refs.into_iter().take(MAX_FILE_REFS) {
        let normalized = file_ref.replace('\\', "/");
        let rel_path = PathBuf::from(&normalized);

        if rel_path.is_absolute() {
            return Err(format!("Invalid @file reference '@{file_ref}': absolute paths are not allowed"));
        }

        let candidate = root.join(&rel_path);
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|_| format!("Could not resolve @file reference '@{file_ref}' in the selected repo"))?;

        if !canonical.starts_with(&root) {
            return Err(format!("Invalid @file reference '@{file_ref}': path escapes the selected repo"));
        }

        let content = std::fs::read_to_string(&canonical)
            .map_err(|err| format!("Failed to read '@{file_ref}': {err}"))?;

        let excerpt = if content.len() > MAX_FILE_BYTES {
            format!(
                "{}\n\n[truncated to {} bytes]",
                &content[..MAX_FILE_BYTES],
                MAX_FILE_BYTES
            )
        } else {
            content
        };

        sections.push(format!("File: {normalized}\n```text\n{excerpt}\n```"));
    }

    if sections.is_empty() {
        return Ok(prompt.to_string());
    }

    Ok(format!(
        "{prompt}\n\nReferenced files from the selected repo:\n\n{}",
        sections.join("\n\n")
    ))
}

fn default_transport_target(agent_id: &str) -> String {
    format!("builtin:{agent_id}")
}

fn resolve_transport_target(agent_id: &str, target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Ok(default_transport_target(agent_id));
    }

    if let Some(command) = trimmed.strip_prefix("stdio:") {
        let command = command.trim();
        if command.is_empty() {
            return Err("ACP stdio target is empty".to_string());
        }
        return Ok(command.to_string());
    }

    if let Some(alias) = trimmed.strip_prefix("builtin:") {
        return builtin_command(alias.trim());
    }

    match trimmed {
        "http://localhost:8330" => builtin_command("claude-code"),
        "http://localhost:8331" => builtin_command("gemini-cli"),
        "http://localhost:8332" => builtin_command("codex-cli"),
        other if other.starts_with("http://") || other.starts_with("https://") => Err(
            "HTTP ACP targets are no longer supported. Use a builtin:* alias or stdio:<command>."
                .to_string(),
        ),
        other => Ok(other.to_string()),
    }
}

fn builtin_command(alias: &str) -> Result<String, String> {
    match alias {
        "claude-code" => Ok("npx -y @zed-industries/claude-code-acp".to_string()),
        "gemini-cli" => Ok("gemini --experimental-acp".to_string()),
        "codex-cli" => Ok("npx -y @zed-industries/codex-acp".to_string()),
        other => Err(format!("Unknown builtin ACP target '{other}'")),
    }
}

fn build_command(command_line: &str, cwd: &str, api_key_ref: Option<&str>, api_key: Option<&str>) -> Result<Command, String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command_line);
        cmd
    } else {
        let parts = shell_words::split(command_line)
            .map_err(|err| format!("Invalid ACP command '{command_line}': {err}"))?;

        let (program, args) = parts
            .split_first()
            .ok_or_else(|| "ACP command is empty".to_string())?;

        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    };

    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let (Some(var), Some(value)) = (api_key_ref, api_key) {
        command.env(var, value);
    }

    Ok(command)
}

// ─── Attempt History Injection ─────────────────────────────────────────────────

async fn build_attempt_history_section(pool: &SqlitePool, work_item_id: &str) -> String {
    let attempts: Vec<(i64, String, String, Option<String>, Option<String>, Option<i64>)> =
        match sqlx::query_as(
            "SELECT attempt_number, agent_id, outcome, rejection_reason, files_changed, duration_ms \
             FROM work_item_attempts WHERE work_item_id = ? ORDER BY attempt_number ASC",
        )
        .bind(work_item_id)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return String::new(),
        };

    if attempts.is_empty() {
        return String::new();
    }

    const MAX_HISTORY_BYTES: usize = 8000;

    let mut out = String::from(
        "## Previous Attempts\n\n\
         IMPORTANT: Review the feedback from previous attempts below. \
         Do NOT repeat the same mistakes.\n\n",
    );

    // If too many attempts, summarize older ones and keep recent 3 in detail.
    let (summary_count, detailed) = if attempts.len() > 3 {
        (attempts.len() - 3, &attempts[attempts.len() - 3..])
    } else {
        (0, attempts.as_slice())
    };

    if summary_count > 0 {
        out.push_str(&format!(
            "{} earlier attempt(s) also failed. Showing the most recent 3:\n\n",
            summary_count,
        ));
    }

    for (attempt_number, agent_id, outcome, rejection_reason, files_changed, duration_ms) in
        detailed
    {
        out.push_str(&format!(
            "### Attempt {} ({}, {})\n",
            attempt_number, agent_id, outcome
        ));
        if let Some(reason) = rejection_reason {
            out.push_str(&format!("**Rejection reason:** {}\n", reason));
        }
        if let Some(files) = files_changed {
            out.push_str(&format!("**Files changed:** {}\n", files));
        }
        if let Some(ms) = duration_ms {
            let secs = *ms as f64 / 1000.0;
            out.push_str(&format!("**Duration:** {:.1}s\n", secs));
        }
        out.push('\n');

        if out.len() > MAX_HISTORY_BYTES {
            out.truncate(MAX_HISTORY_BYTES);
            out.push_str("\n[attempt history truncated]\n");
            break;
        }
    }

    out
}

// ─── Agent Config Commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_agent_configs(db: State<'_, SqlitePool>) -> Result<Vec<AgentConfig>, String> {
    sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled, strengths, weaknesses, best_for, reasoning_class, speed_class, edit_reliability \
         FROM agent_config ORDER BY id",
    )
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_agent_config(
    db: State<'_, SqlitePool>,
    id: String,
    display_name: String,
    acp_url: String,
    api_key_ref: Option<String>,
    model: Option<String>,
    max_concurrent: Option<i64>,
    enabled: Option<i64>,
    strengths: Option<String>,
    weaknesses: Option<String>,
    best_for: Option<String>,
    reasoning_class: Option<String>,
    speed_class: Option<String>,
    edit_reliability: Option<String>,
) -> Result<AgentConfig, String> {
    let max_concurrent = max_concurrent.unwrap_or(1);
    let enabled = enabled.unwrap_or(1);

    sqlx::query(
        r#"INSERT INTO agent_config
             (id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled, strengths, weaknesses, best_for, reasoning_class, speed_class, edit_reliability)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name   = excluded.display_name,
             acp_url        = excluded.acp_url,
             api_key_ref    = excluded.api_key_ref,
             model          = excluded.model,
             max_concurrent = excluded.max_concurrent,
             enabled        = excluded.enabled,
             strengths      = excluded.strengths,
             weaknesses     = excluded.weaknesses,
             best_for       = excluded.best_for,
             reasoning_class = excluded.reasoning_class,
             speed_class    = excluded.speed_class,
             edit_reliability = excluded.edit_reliability"#,
    )
    .bind(&id)
    .bind(&display_name)
    .bind(&acp_url)
    .bind(&api_key_ref)
    .bind(&model)
    .bind(max_concurrent)
    .bind(enabled)
    .bind(&strengths)
    .bind(&weaknesses)
    .bind(&best_for)
    .bind(&reasoning_class)
    .bind(&speed_class)
    .bind(&edit_reliability)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled, strengths, weaknesses, best_for, reasoning_class, speed_class, edit_reliability \
         FROM agent_config WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_agent_config(db: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM agent_config WHERE id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Agent Launch (ACP) ───────────────────────────────────────────────────────

struct AgentTurnRequest {
    work_item_id: String,
    agent_id: String,
    acp_target: String,
    prompt: String,
    worktree_path: String,
    api_key_ref: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

async fn build_turn_request(
    pool: &SqlitePool,
    work_item_id: &str,
    extra_instruction: Option<String>,
) -> Result<AgentTurnRequest, String> {
    let row = sqlx::query(
        "SELECT context, execution_context, worktree_path, assigned_agent FROM work_items WHERE id = ?",
    )
    .bind(work_item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Work item {} not found", work_item_id))?;

    let context: Option<String> = row.try_get("context").ok().flatten();
    let execution_context: Option<String> = row.try_get("execution_context").ok().flatten();
    let worktree_path: Option<String> = row.try_get("worktree_path").ok().flatten();
    let assigned_agent: Option<String> = row.try_get("assigned_agent").ok().flatten();

    let worktree_path = worktree_path.ok_or("Work item has no worktree_path; run create_worktree first")?;
    let agent_id = assigned_agent.ok_or("Work item has no assigned_agent")?;

    let agent = sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled, strengths, weaknesses, best_for, reasoning_class, speed_class, edit_reliability \
         FROM agent_config WHERE id = ?",
    )
    .bind(&agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Agent config '{}' not found", agent_id))?;

    let base_prompt = execution_context
        .filter(|s| !s.trim().is_empty())
        .or(context.filter(|s| !s.trim().is_empty()))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Work item is missing executable context".to_string())?;

    // Inject attempt history so agents learn from prior rejections.
    let attempt_history = build_attempt_history_section(pool, &work_item_id).await;
    let base_prompt = if attempt_history.is_empty() {
        base_prompt
    } else {
        format!("{base_prompt}\n\n{attempt_history}")
    };

    let full_prompt = match extra_instruction {
        Some(message) if !message.trim().is_empty() => format!(
            "{base_prompt}\n\nContinue from the current worktree state.\n\nFollow-up user message:\n{}",
            message.trim()
        ),
        _ => base_prompt,
    };
    let full_prompt = expand_prompt_with_file_refs(&full_prompt, &worktree_path)?;

    let api_key = agent
        .api_key_ref
        .as_deref()
        .and_then(|var| std::env::var(var).ok());

    Ok(AgentTurnRequest {
        work_item_id: work_item_id.to_string(),
        agent_id,
        acp_target: agent.acp_url,
        prompt: full_prompt,
        worktree_path,
        api_key_ref: agent.api_key_ref.clone(),
        api_key,
        model: agent.model,
    })
}

async fn insert_agent_log(pool: &SqlitePool, work_item_id: &str, agent_id: &str) -> Result<String, String> {
    let log_id = Ulid::new().to_string();
    sqlx::query("INSERT INTO agent_logs (id, work_item_id, agent_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(&log_id)
        .bind(work_item_id)
        .bind(agent_id)
        .bind(now_iso())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(log_id)
}

async fn finalize_start_failure(
    app: AppHandle,
    work_item_id: String,
    pool: &SqlitePool,
    log_id: &str,
    message: String,
) {
    emit_error_event(&app, &work_item_id, log_id, &message);
    finalize(
        &app,
        pool,
        &work_item_id,
        log_id,
        None,
        &[],
        None,
        None,
        1,
        0,
        Some(message),
        false,
        None,
    )
    .await;
}

async fn start_agent_run(
    app: AppHandle,
    pool: &SqlitePool,
    work_item_id: String,
    slot: u8,
    active_sessions: State<'_, ActiveSessions>,
    extra_instruction: Option<String>,
    permission_policy: Option<AgentPermissionPolicy>,
) -> Result<String, String> {
    let request = build_turn_request(pool, &work_item_id, extra_instruction).await?;
    let log_id = insert_agent_log(pool, &request.work_item_id, &request.agent_id).await?;

    let handle = match get_or_create_session_handle(
        &app,
        pool,
        active_sessions.inner(),
        &request,
        slot,
        permission_policy,
    )
    .await
    {
        Ok(handle) => handle,
        Err(err) => {
            finalize_start_failure(app, work_item_id, pool, &log_id, err.clone()).await;
            return Err(err);
        }
    };

    if let Err(err) = start_turn(&handle, log_id.clone(), request.prompt).await {
        finalize_start_failure(app, work_item_id, pool, &log_id, err.clone()).await;
        return Err(err);
    }

    Ok(log_id)
}

#[tauri::command]
pub async fn launch_agent(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
    slot: u8,
    permission_policy: Option<AgentPermissionPolicy>,
) -> Result<String, String> {
    start_agent_run(
        app,
        db.inner(),
        work_item_id,
        slot,
        active_sessions,
        None,
        permission_policy,
    )
    .await
}

#[tauri::command]
pub async fn continue_agent(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
    slot: u8,
    message: String,
    permission_policy: Option<AgentPermissionPolicy>,
) -> Result<String, String> {
    if let Some(handle) = get_session_handle(active_sessions.inner(), &work_item_id)? {
        handle.set_slot(slot);
        if handle.shared.snapshot().is_running {
            cancel_turn(&handle).await?;
        }
    }

    start_agent_run(
        app,
        db.inner(),
        work_item_id,
        slot,
        active_sessions,
        Some(message),
        permission_policy,
    )
    .await
}

#[tauri::command]
pub async fn interrupt_agent(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    shutdown_work_item_session(active_sessions.inner(), &work_item_id).await
}

#[tauri::command]
pub async fn cancel_agent_turn(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    if let Some(handle) = get_session_handle(active_sessions.inner(), &work_item_id)? {
        return cancel_turn(&handle).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_agent_session(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    shutdown_work_item_session(active_sessions.inner(), &work_item_id).await
}

#[tauri::command]
pub async fn shutdown_all_agent_sessions(
    active_sessions: State<'_, ActiveSessions>,
) -> Result<(), String> {
    shutdown_all_sessions(active_sessions.inner()).await
}

#[tauri::command]
pub async fn get_agent_session(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<Option<AgentSessionState>, String> {
    let Some(handle) = get_session_handle(active_sessions.inner(), &work_item_id)? else {
        return Ok(None);
    };
    let state = handle.shared.snapshot();
    if state.session_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(state))
}

#[tauri::command]
pub async fn set_agent_permission_policy(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
    policy: AgentPermissionPolicy,
) -> Result<AgentSessionState, String> {
    let handle = get_session_handle(active_sessions.inner(), &work_item_id)?
        .ok_or_else(|| "No active agent session for this work item".to_string())?;
    let updated = handle.shared.update_snapshot(|state| {
        state.permission_policy = policy.clone();
        state.last_activity_at = now_iso();
        state.idle_deadline_at = idle_deadline_iso();
    });
    handle.shared.emit_state();
    let _ = touch_session(&handle).await;
    Ok(updated)
}

#[tauri::command]
pub async fn respond_to_agent_permission(
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let handle = get_session_handle(active_sessions.inner(), &work_item_id)?
        .ok_or_else(|| "No active agent session for this work item".to_string())?;
    handle.shared.respond_to_permission(&request_id, option_id)?;
    handle.shared.mark_activity();
    Ok(())
}

async fn get_or_create_session_handle(
    app: &AppHandle,
    pool: &SqlitePool,
    active_sessions: &ActiveSessions,
    request: &AgentTurnRequest,
    slot: u8,
    initial_policy: Option<AgentPermissionPolicy>,
) -> Result<ActiveSessionHandle, String> {
    if let Some(handle) = get_session_handle(active_sessions, &request.work_item_id)? {
        if handle.shared.snapshot().agent_id != request.agent_id {
            shutdown_work_item_session(active_sessions, &request.work_item_id).await?;
        } else {
            handle.set_slot(slot);
            if let Some(policy) = initial_policy {
                let _ = handle.shared.update_snapshot(|state| {
                    state.permission_policy = policy.clone();
                    state.last_activity_at = now_iso();
                    state.idle_deadline_at = idle_deadline_iso();
                });
                handle.shared.emit_state();
                let _ = touch_session(&handle).await;
            }
            return Ok(handle);
        }
    }

    let permission_policy = initial_policy.unwrap_or(AgentPermissionPolicy::AllowOnce);
    let shared = SessionShared {
        app: app.clone(),
        work_item_id: request.work_item_id.clone(),
        agent_id: request.agent_id.clone(),
        worktree_root: PathBuf::from(&request.worktree_path),
        snapshot: Arc::new(Mutex::new(AgentSessionState {
            work_item_id: request.work_item_id.clone(),
            agent_id: request.agent_id.clone(),
            session_id: String::new(),
            is_running: false,
            opened_at: now_iso(),
            last_activity_at: now_iso(),
            idle_deadline_at: idle_deadline_iso(),
            permission_policy,
            pending_permission: None,
        })),
        current_log_id: Arc::new(Mutex::new(None)),
        turn_events: Arc::new(Mutex::new(Vec::new())),
        pending_permission: Arc::new(Mutex::new(None)),
    };
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let handle = ActiveSessionHandle {
        slot: Arc::new(Mutex::new(slot)),
        command_tx,
        shared: shared.clone(),
    };

    {
        let mut sessions = active_sessions
            .0
            .lock()
            .map_err(|_| "Active session state is unavailable".to_string())?;
        sessions.insert(request.work_item_id.clone(), handle.clone());
    }

    let (ready_tx, ready_rx) = oneshot::channel();
    let pool_bg = pool.clone();
    let active_sessions_bg = active_sessions.clone();
    let request_bg = AgentTurnRequest {
        work_item_id: request.work_item_id.clone(),
        agent_id: request.agent_id.clone(),
        acp_target: request.acp_target.clone(),
        prompt: String::new(),
        worktree_path: request.worktree_path.clone(),
        api_key_ref: request.api_key_ref.clone(),
        api_key: request.api_key.clone(),
        model: request.model.clone(),
    };

    std::thread::spawn({
        let app = app.clone();
        move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = ready_tx.send(Err(format!("Failed to create ACP runtime: {err}")));
                    if let Ok(mut sessions) = active_sessions_bg.0.lock() {
                        sessions.remove(request_bg.work_item_id.as_str());
                    }
                    emit_session_state(&app, &request_bg.work_item_id, None);
                    return;
                }
            };

            runtime.block_on(run_session_worker(
                app,
                pool_bg,
                active_sessions_bg,
                request_bg,
                shared,
                command_rx,
                ready_tx,
            ));
        }
    });

    match ready_rx.await {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(err)) => {
            if let Ok(mut sessions) = active_sessions.0.lock() {
                sessions.remove(request.work_item_id.as_str());
            }
            emit_session_state(app, &request.work_item_id, None);
            Err(err)
        }
        Err(_) => {
            if let Ok(mut sessions) = active_sessions.0.lock() {
                sessions.remove(request.work_item_id.as_str());
            }
            emit_session_state(app, &request.work_item_id, None);
            Err("ACP session setup terminated unexpectedly".to_string())
        }
    }
}

async fn run_session_worker(
    app: AppHandle,
    pool: SqlitePool,
    active_sessions: ActiveSessions,
    request: AgentTurnRequest,
    shared: SessionShared,
    mut command_rx: mpsc::UnboundedReceiver<SessionCommand>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) {
    let _ = request.model.as_deref();
    let target = match resolve_transport_target(&request.agent_id, &request.acp_target) {
        Ok(target) => target,
        Err(err) => {
            let _ = ready_tx.send(Err(err));
            if let Ok(mut sessions) = active_sessions.0.lock() {
                sessions.remove(request.work_item_id.as_str());
            }
            emit_session_state(&app, &request.work_item_id, None);
            return;
        }
    };
    let work_item_id_after = request.work_item_id.clone();
    let app_after = app.clone();

    tokio::task::LocalSet::new()
        .run_until(async move {
            let mut command = match build_command(
                &target,
                &request.worktree_path,
                request.api_key_ref.as_deref(),
                request.api_key.as_deref(),
            ) {
                Ok(command) => command,
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
            };

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(err) => {
                    let _ = ready_tx.send(Err(format!("Failed to start ACP agent '{target}': {err}")));
                    return;
                }
            };

            let child_stdin = match child.stdin.take() {
                Some(stdin) => stdin,
                None => {
                    let _ = ready_tx.send(Err("ACP agent stdin unavailable".to_string()));
                    return;
                }
            };
            let child_stdout = match child.stdout.take() {
                Some(stdout) => stdout,
                None => {
                    let _ = ready_tx.send(Err("ACP agent stdout unavailable".to_string()));
                    return;
                }
            };
            let mut child_stderr = child.stderr.take();

            let stderr_task = tokio::task::spawn_local(async move {
                let mut stderr = Vec::new();
                if let Some(mut stream) = child_stderr.take() {
                    let _ = stream.read_to_end(&mut stderr).await;
                }
                String::from_utf8_lossy(&stderr).trim().to_string()
            });

            let handler = AcpClientHandler { shared: shared.clone() };
            let (connection, io_task) = ClientSideConnection::new(
                handler.clone(),
                child_stdin.compat_write(),
                child_stdout.compat(),
                |fut| {
                    tokio::task::spawn_local(fut);
                },
            );
            let io_task = tokio::task::spawn_local(async move {
                let _ = io_task.await;
            });

            let init = connection
                .initialize(
                    InitializeRequest::new(ProtocolVersion::LATEST)
                        .client_capabilities(
                            ClientCapabilities::new().fs(
                                FileSystemCapability::new()
                                    .read_text_file(true)
                                    .write_text_file(true),
                            ),
                        )
                        .client_info(Implementation::new("mozzie", "0.1.0")),
                )
                .await;

            if let Err(err) = init {
                let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", err.message)));
                let _ = child.kill().await;
                let _ = child.wait().await;
                return;
            }

            let session = match connection
                .new_session(NewSessionRequest::new(request.worktree_path.clone()))
                .await
            {
                Ok(session) => session,
                Err(err) => {
                    let _ = ready_tx.send(Err(format!("ACP session creation failed: {}", err.message)));
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return;
                }
            };
            let session_id = session.session_id.to_string();

            let now = now_iso();
            let deadline = idle_deadline_iso();
            let _ = shared.update_snapshot(|state| {
                state.session_id = session_id.clone();
                state.opened_at = now.clone();
                state.last_activity_at = now.clone();
                state.idle_deadline_at = deadline.clone();
            });
            shared.emit_state();
            let _ = ready_tx.send(Ok(()));

            let mut should_shutdown = false;

            while !should_shutdown {
                let idle_sleep = tokio::time::sleep(Duration::from_secs(15 * 60));
                tokio::pin!(idle_sleep);

                tokio::select! {
                    maybe_command = command_rx.recv() => {
                        let Some(command) = maybe_command else {
                            should_shutdown = true;
                            continue;
                        };

                        match command {
                            SessionCommand::StartTurn { log_id, prompt, reply } => {
                                shared.clear_turn_events();
                                shared.set_current_log_id(Some(log_id.clone()));
                                let _ = shared.update_snapshot(|state| {
                                    state.is_running = true;
                                    state.pending_permission = None;
                                    state.last_activity_at = now_iso();
                                    state.idle_deadline_at = idle_deadline_iso();
                                });
                                shared.emit_state();
                                let _ = reply.send(Ok(()));

                                let turn = run_prompt_turn(
                                    &connection,
                                    &session_id,
                                    &prompt,
                                    &shared,
                                    &mut command_rx,
                                )
                                .await;

                                let events = shared.take_turn_events();
                                if turn.exit_code == 0 && events.is_empty() {
                                    emit_error_event(&app, &request.work_item_id, &log_id, "ACP run completed without output");
                                } else if let Some(message) = turn.error_summary.as_deref() {
                                    emit_error_event(&app, &request.work_item_id, &log_id, message);
                                }

                                finalize(
                                    &app,
                                    &pool,
                                    &request.work_item_id,
                                    &log_id,
                                    Some(session_id.as_str()),
                                    &events,
                                    None,
                                    None,
                                    turn.exit_code,
                                    turn.duration_ms,
                                    turn.error_summary,
                                    false,
                                    None,
                                )
                                .await;

                                shared.set_current_log_id(None);
                                shared.clear_pending_permission();
                                let _ = shared.update_snapshot(|state| {
                                    state.is_running = false;
                                    state.last_activity_at = now_iso();
                                    state.idle_deadline_at = idle_deadline_iso();
                                });
                                shared.emit_state();

                                if turn.shutdown_after {
                                    should_shutdown = true;
                                }
                            }
                            SessionCommand::CancelTurn { reply } => {
                                let _ = reply.send(Ok(()));
                            }
                            SessionCommand::Shutdown { reply } => {
                                if let Some(reply) = reply {
                                    let _ = reply.send(Ok(()));
                                }
                                should_shutdown = true;
                            }
                            SessionCommand::Touch => {
                                shared.mark_activity();
                            }
                        }
                    }
                    _ = &mut idle_sleep => {
                        should_shutdown = true;
                    }
                }
            }

            shared.clear_pending_permission();
            shared.set_current_log_id(None);
            drop(connection);
            let mut io_task = io_task;
            if timeout(Duration::from_secs(2), &mut io_task).await.is_err() {
                io_task.abort();
            }
            if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            let _ = stderr_task.await.unwrap_or_default();
        })
        .await;

    if let Ok(mut sessions) = active_sessions.0.lock() {
        sessions.remove(work_item_id_after.as_str());
    }
    emit_session_state(&app_after, &work_item_id_after, None);
}

struct PromptTurnResult {
    duration_ms: i64,
    exit_code: i64,
    error_summary: Option<String>,
    shutdown_after: bool,
}

async fn run_prompt_turn(
    connection: &ClientSideConnection,
    session_id: &str,
    prompt: &str,
    shared: &SessionShared,
    command_rx: &mut mpsc::UnboundedReceiver<SessionCommand>,
) -> PromptTurnResult {
    let start = Instant::now();
    let prompt_future = connection.prompt(PromptRequest::new(
        session_id.to_string(),
        vec![ContentBlock::from(prompt.to_string())],
    ));
    tokio::pin!(prompt_future);

    let mut shutdown_after = false;
    let mut cancel_waiters: Vec<oneshot::Sender<Result<(), String>>> = Vec::new();

    loop {
        tokio::select! {
            result = &mut prompt_future => {
                for reply in cancel_waiters {
                    let _ = reply.send(Ok(()));
                }

                let (exit_code, error_summary) = match result {
                    Ok(response) if response.stop_reason == StopReason::EndTurn => (0, None),
                    Ok(response) => (
                        130,
                        Some(format!("Agent stopped with {:?}", response.stop_reason)),
                    ),
                    Err(err) => (
                        1,
                        Some(format!("ACP prompt failed: {}", err.message)),
                    ),
                };

                let duration_ms = start.elapsed().as_millis() as i64;

                return PromptTurnResult {
                    duration_ms,
                    exit_code,
                    error_summary,
                    shutdown_after,
                };
            }
            maybe_command = command_rx.recv() => {
                let Some(command) = maybe_command else {
                    shutdown_after = true;
                    let _ = connection
                        .cancel(CancelNotification::new(session_id.to_string()))
                        .await;
                    continue;
                };

                match command {
                    SessionCommand::StartTurn { reply, .. } => {
                        let _ = reply.send(Err("A prompt is already running for this work item".to_string()));
                    }
                    SessionCommand::CancelTurn { reply } => {
                        match connection
                            .cancel(CancelNotification::new(session_id.to_string()))
                            .await
                        {
                            Ok(()) => cancel_waiters.push(reply),
                            Err(err) => {
                                let _ = reply.send(Err(format!("Failed to cancel prompt: {}", err.message)));
                            }
                        }
                    }
                    SessionCommand::Shutdown { reply } => {
                        shutdown_after = true;
                        let _ = connection
                            .cancel(CancelNotification::new(session_id.to_string()))
                            .await;
                        if let Some(reply) = reply {
                            cancel_waiters.push(reply);
                        }
                        shared.clear_pending_permission();
                    }
                    SessionCommand::Touch => {
                        shared.mark_activity();
                    }
                }
            }
        }
    }
}

fn get_session_handle(
    active_sessions: &ActiveSessions,
    work_item_id: &str,
) -> Result<Option<ActiveSessionHandle>, String> {
    let sessions = active_sessions
        .0
        .lock()
        .map_err(|_| "Active session state is unavailable".to_string())?;
    Ok(sessions.get(work_item_id).cloned())
}

async fn start_turn(
    handle: &ActiveSessionHandle,
    log_id: String,
    prompt: String,
) -> Result<(), String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .command_tx
        .send(SessionCommand::StartTurn {
            log_id,
            prompt,
            reply: reply_tx,
        })
        .map_err(|_| "Agent session is unavailable".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Agent session did not acknowledge the prompt".to_string())?
}

async fn cancel_turn(handle: &ActiveSessionHandle) -> Result<(), String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .command_tx
        .send(SessionCommand::CancelTurn { reply: reply_tx })
        .map_err(|_| "Agent session is unavailable".to_string())?;
    reply_rx
        .await
        .map_err(|_| "Agent session did not confirm the cancellation".to_string())?
}

async fn touch_session(handle: &ActiveSessionHandle) -> Result<(), String> {
    handle
        .command_tx
        .send(SessionCommand::Touch)
        .map_err(|_| "Agent session is unavailable".to_string())
}

pub(crate) async fn shutdown_work_item_session(
    active_sessions: &ActiveSessions,
    work_item_id: &str,
) -> Result<(), String> {
    let Some(handle) = get_session_handle(active_sessions, work_item_id)? else {
        return Ok(());
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    handle
        .command_tx
        .send(SessionCommand::Shutdown { reply: Some(reply_tx) })
        .map_err(|_| "Agent session is unavailable".to_string())?;
    let _ = reply_rx
        .await
        .map_err(|_| "Agent session did not acknowledge shutdown".to_string())?;

    for _ in 0..60 {
        if get_session_handle(active_sessions, work_item_id)?.is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Err("Agent session did not shut down cleanly".to_string())
}

async fn shutdown_all_sessions(active_sessions: &ActiveSessions) -> Result<(), String> {
    let work_item_ids = {
        let sessions = active_sessions
            .0
            .lock()
            .map_err(|_| "Active session state is unavailable".to_string())?;
        sessions.keys().cloned().collect::<Vec<_>>()
    };

    for work_item_id in work_item_ids {
        let _ = shutdown_work_item_session(active_sessions, &work_item_id).await;
    }

    Ok(())
}

fn emit_error_event(app: &AppHandle, work_item_id: &str, log_id: &str, message: &str) {
    let item = AcpEventItem {
        id: Ulid::new().to_string(),
        kind: "error".to_string(),
        content: Some(message.to_string()),
        tool_name: None,
        tool_input: None,
        tool_call_id: None,
        ts: now_iso(),
    };
    emit_acp_event(app, work_item_id, log_id, &item);
}

fn emit_acp_event(app: &AppHandle, work_item_id: &str, log_id: &str, item: &AcpEventItem) {
    let _ = app.emit(
        "acp:event",
        serde_json::json!({
            "workItemId": work_item_id,
            "logId": log_id,
            "item": item,
        }),
    );
}

fn emit_session_state(app: &AppHandle, work_item_id: &str, state: Option<&AgentSessionState>) {
    let _ = app.emit(
        "agent:session-state",
        serde_json::json!({
            "workItemId": work_item_id,
            "state": state,
        }),
    );
}

fn emit_log_change(app: &AppHandle, work_item_id: &str, log_id: &str) {
    let _ = app.emit(
        "agent:log-change",
        serde_json::json!({
            "workItemId": work_item_id,
            "logId": log_id,
        }),
    );
}

async fn finalize(
    app: &AppHandle,
    pool: &SqlitePool,
    work_item_id: &str,
    log_id: &str,
    run_id: Option<&str>,
    events: &[AcpEventItem],
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
    exit_code: i64,
    duration_ms: i64,
    error_summary: Option<String>,
    cleanup_warning: bool,
    cleanup_warning_message: Option<String>,
) {
    let messages_json = serde_json::to_string(events).unwrap_or_else(|_| "[]".to_string());
    let to_status = "ready";
    let now = now_iso();

    let _ = sqlx::query(
        "UPDATE agent_logs \
         SET run_id = ?, messages = ?, summary = ?, tokens_in = ?, tokens_out = ?, \
             exit_code = ?, duration_ms = ?, cleanup_warning = ?, cleanup_warning_message = ? \
         WHERE id = ?",
    )
    .bind(run_id)
    .bind(&messages_json)
    .bind(error_summary.as_deref())
    .bind(tokens_in)
    .bind(tokens_out)
    .bind(exit_code)
    .bind(duration_ms)
    .bind(if cleanup_warning { Some(1_i64) } else { Some(0_i64) })
    .bind(cleanup_warning_message.as_deref())
    .bind(log_id)
    .execute(pool)
    .await;

    if to_status == "ready" {
        let _ = sqlx::query(
            "UPDATE work_items SET status = ?, completed_at = ?, updated_at = ?, terminal_slot = NULL \
             WHERE id = ? AND status = 'running'",
        )
        .bind(to_status)
        .bind(&now)
        .bind(&now)
        .bind(work_item_id)
        .execute(pool)
        .await;
    } else {
        let _ = sqlx::query(
            "UPDATE work_items SET status = ?, completed_at = ?, updated_at = ? \
             WHERE id = ? AND status = 'running'",
        )
        .bind(to_status)
        .bind(&now)
        .bind(&now)
        .bind(work_item_id)
        .execute(pool)
        .await;
    }

    let _ = app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": work_item_id,
            "from": "running",
            "to": to_status,
        }),
    );
    emit_log_change(app, work_item_id, log_id);
}

// ─── Agent Log Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_agent_logs(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<Vec<AgentLog>, String> {
    sqlx::query_as::<_, AgentLog>(
        "SELECT id, work_item_id, agent_id, run_id, messages, summary, tokens_in, tokens_out, \
         cost_usd, exit_code, duration_ms, cleanup_warning, cleanup_warning_message, created_at \
         FROM agent_logs WHERE work_item_id = ? ORDER BY created_at DESC",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_acp_messages(
    db: State<'_, SqlitePool>,
    log_id: String,
) -> Result<Vec<AcpEventItem>, String> {
    let row = sqlx::query("SELECT messages FROM agent_logs WHERE id = ?")
        .bind(&log_id)
        .fetch_optional(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    let messages_json: Option<String> = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("messages").ok().flatten());

    match messages_json {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        None => Ok(vec![]),
    }
}
