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
    #[serde(default)]
    pub seq: i64,
    /// "text" | "text_delta" | "tool_call" | "tool_result" | "error" | "done" | "user_message"
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

#[derive(Debug, Clone, sqlx::FromRow)]
struct WorkItemChatMessage {
    id: String,
    work_item_id: String,
    role: String,
    content: String,
    agent_log_id: Option<String>,
    created_at: String,
}

struct PendingPermissionDecision {
    request_id: String,
    reply: oneshot::Sender<Option<String>>,
}

#[derive(Clone)]
struct SessionShared {
    app: AppHandle,
    pool: SqlitePool,
    work_item_id: String,
    agent_id: String,
    worktree_root: PathBuf,
    snapshot: Arc<Mutex<AgentSessionState>>,
    current_log_id: Arc<Mutex<Option<String>>>,
    current_log_seq: Arc<Mutex<i64>>,
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
        if let Ok(mut seq) = self.current_log_seq.lock() {
            *seq = 0;
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

    fn next_turn_seq(&self) -> i64 {
        self.current_log_seq
            .lock()
            .map(|mut seq| {
                *seq += 1;
                *seq
            })
            .unwrap_or(0)
    }

    async fn push_turn_event(&self, mut item: AcpEventItem) {
        if item.seq <= 0 {
            item.seq = self.next_turn_seq();
        }
        if let Ok(mut events) = self.turn_events.lock() {
            events.push(item.clone());
        }
        if let Some(log_id) = self.current_log_id() {
            let _ = persist_agent_log_event(&self.pool, &log_id, &item).await;
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
    async fn push_item(&self, item: AcpEventItem) {
        self.shared.push_turn_event(item).await;
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
            self.push_item(item).await;
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
            seq: 0,
            kind: "tool_result".to_string(),
            content: Some(format!("Wrote {}", args.path.display())),
            tool_name: Some("fs.write_text_file".to_string()),
            tool_input: None,
            tool_call_id: None,
            ts: now_iso(),
        }).await;

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
        seq: 0,
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

fn resolve_command_cwd(command_line: &str, worktree_cwd: &str) -> PathBuf {
    let uses_npx_wrapper = command_line.contains("@zed-industries/claude-code-acp")
        || command_line.contains("@zed-industries/codex-acp");

    if uses_npx_wrapper {
        return std::env::temp_dir();
    }

    PathBuf::from(worktree_cwd)
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

    let launch_cwd = resolve_command_cwd(command_line, cwd);
    command
        .current_dir(launch_cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let (Some(var), Some(value)) = (api_key_ref, api_key) {
        command.env(var, value);
    }

    Ok(command)
}

fn format_acp_startup_error(message: String, stderr: String) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return message;
    }

    format!("{message}. stderr: {stderr}")
}

async fn next_log_event_seq(pool: &SqlitePool, log_id: &str) -> Result<i64, String> {
    let row = sqlx::query("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_log_events WHERE log_id = ?")
        .bind(log_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(row.try_get::<i64, _>("next_seq").unwrap_or(1))
}

async fn persist_agent_log_event(pool: &SqlitePool, log_id: &str, item: &AcpEventItem) -> Result<(), String> {
    let item_json = serde_json::to_string(item).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT OR REPLACE INTO agent_log_events (id, log_id, seq, item_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&item.id)
    .bind(log_id)
    .bind(item.seq)
    .bind(item_json)
    .bind(&item.ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn append_agent_log_event(
    pool: &SqlitePool,
    log_id: &str,
    mut item: AcpEventItem,
) -> Result<AcpEventItem, String> {
    if item.seq <= 0 {
        item.seq = next_log_event_seq(pool, log_id).await?;
    }
    persist_agent_log_event(pool, log_id, &item).await?;
    Ok(item)
}

fn normalize_legacy_events(mut events: Vec<AcpEventItem>) -> Vec<AcpEventItem> {
    for (index, item) in events.iter_mut().enumerate() {
        if item.seq <= 0 {
            item.seq = (index + 1) as i64;
        }
    }
    events
}

async fn get_log_events(pool: &SqlitePool, log_id: &str) -> Result<Vec<AcpEventItem>, String> {
    let rows = sqlx::query("SELECT item_json FROM agent_log_events WHERE log_id = ? ORDER BY seq ASC")
        .bind(log_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let item_json: String = row.try_get("item_json").map_err(|e| e.to_string())?;
        let item: AcpEventItem = serde_json::from_str(&item_json).map_err(|e| e.to_string())?;
        items.push(item);
    }

    Ok(items)
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

async fn build_agent_turn_request_base(
    pool: &SqlitePool,
    work_item_id: &str,
) -> Result<AgentTurnRequest, String> {
    let row = sqlx::query(
        "SELECT worktree_path, assigned_agent FROM work_items WHERE id = ?",
    )
    .bind(work_item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Work item {} not found", work_item_id))?;

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

    let api_key = agent
        .api_key_ref
        .as_deref()
        .and_then(|var| std::env::var(var).ok());

    Ok(AgentTurnRequest {
        work_item_id: work_item_id.to_string(),
        agent_id,
        acp_target: agent.acp_url,
        prompt: String::new(),
        worktree_path,
        api_key_ref: agent.api_key_ref.clone(),
        api_key,
        model: agent.model,
    })
}

async fn build_work_item_base_prompt(
    pool: &SqlitePool,
    work_item_id: &str,
) -> Result<String, String> {
    let row = sqlx::query(
        "SELECT context, execution_context FROM work_items WHERE id = ?",
    )
    .bind(work_item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Work item {} not found", work_item_id))?;

    let context: Option<String> = row.try_get("context").ok().flatten();
    let execution_context: Option<String> = row.try_get("execution_context").ok().flatten();

    let base_prompt = execution_context
        .filter(|s| !s.trim().is_empty())
        .or(context.filter(|s| !s.trim().is_empty()))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Work item is missing executable context".to_string())?;

    let attempt_history = build_attempt_history_section(pool, &work_item_id).await;
    Ok(if attempt_history.is_empty() {
        base_prompt
    } else {
        format!("{base_prompt}\n\n{attempt_history}")
    })
}

async fn build_turn_request(
    pool: &SqlitePool,
    work_item_id: &str,
    extra_instruction: Option<String>,
) -> Result<AgentTurnRequest, String> {
    let mut request = build_agent_turn_request_base(pool, work_item_id).await?;
    let base_prompt = build_work_item_base_prompt(pool, work_item_id).await?;

    let full_prompt = match extra_instruction {
        Some(message) if !message.trim().is_empty() => format!(
            "{base_prompt}\n\nContinue from the current worktree state.\n\nFollow-up user message:\n{}",
            message.trim()
        ),
        _ => base_prompt,
    };
    request.prompt = expand_prompt_with_file_refs(&full_prompt, &request.worktree_path)?;
    Ok(request)
}

async fn list_work_item_chat_messages(
    pool: &SqlitePool,
    work_item_id: &str,
) -> Result<Vec<WorkItemChatMessage>, String> {
    sqlx::query_as::<_, WorkItemChatMessage>(
        "SELECT id, work_item_id, role, content, agent_log_id, created_at \
         FROM work_item_chat_messages WHERE work_item_id = ? ORDER BY created_at ASC",
    )
    .bind(work_item_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

async fn insert_work_item_chat_message(
    pool: &SqlitePool,
    work_item_id: &str,
    role: &str,
    content: &str,
    agent_log_id: Option<&str>,
    created_at: Option<&str>,
) -> Result<Option<WorkItemChatMessage>, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let record = WorkItemChatMessage {
        id: Ulid::new().to_string(),
        work_item_id: work_item_id.to_string(),
        role: role.to_string(),
        content: trimmed.to_string(),
        agent_log_id: agent_log_id.map(str::to_string),
        created_at: created_at
            .map(str::to_string)
            .unwrap_or_else(now_iso),
    };

    sqlx::query(
        "INSERT INTO work_item_chat_messages (id, work_item_id, role, content, agent_log_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&record.id)
    .bind(&record.work_item_id)
    .bind(&record.role)
    .bind(&record.content)
    .bind(&record.agent_log_id)
    .bind(&record.created_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(record))
}

async fn work_item_has_chat_messages(pool: &SqlitePool, work_item_id: &str) -> Result<bool, String> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM work_item_chat_messages WHERE work_item_id = ?",
    )
    .bind(work_item_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(count > 0)
}

async fn work_item_has_resume_history(pool: &SqlitePool, work_item_id: &str) -> Result<bool, String> {
    if work_item_has_chat_messages(pool, work_item_id).await? {
        return Ok(true);
    }

    let log_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_logs WHERE work_item_id = ?",
    )
    .bind(work_item_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    if log_count > 0 {
        return Ok(true);
    }

    let started_at = sqlx::query_scalar::<_, Option<String>>(
        "SELECT started_at FROM work_items WHERE id = ?",
    )
    .bind(work_item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .flatten();

    Ok(started_at
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false))
}

async fn ensure_work_item_chat_bootstrap(
    pool: &SqlitePool,
    work_item_id: &str,
    prompt: &str,
) -> Result<(), String> {
    if work_item_has_chat_messages(pool, work_item_id).await? {
        return Ok(());
    }

    insert_work_item_chat_message(pool, work_item_id, "system", prompt, None, None)
        .await
        .map(|_| ())
}

async fn ensure_work_item_chat_bootstrap_from_work_item(
    pool: &SqlitePool,
    work_item_id: &str,
) -> Result<(), String> {
    if work_item_has_chat_messages(pool, work_item_id).await? {
        return Ok(());
    }

    let prompt = build_work_item_base_prompt(pool, work_item_id).await?;
    ensure_work_item_chat_bootstrap(pool, work_item_id, &prompt).await
}

fn extract_assistant_chat_text(events: &[AcpEventItem]) -> String {
    let prose = events
        .iter()
        .filter(|item| matches!(item.kind.as_str(), "text" | "text_delta"))
        .filter_map(|item| item.content.as_deref())
        .collect::<String>()
        .trim()
        .to_string();

    if !prose.is_empty() {
        return prose;
    }

    events
        .iter()
        .filter(|item| item.kind == "error")
        .filter_map(|item| item.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn work_item_chat_message_to_event(message: &WorkItemChatMessage) -> AcpEventItem {
    AcpEventItem {
        id: message.id.clone(),
        seq: 0,
        kind: "user_message".to_string(),
        content: Some(message.content.clone()),
        tool_name: None,
        tool_input: None,
        tool_call_id: None,
        ts: message.created_at.clone(),
    }
}

async fn persist_assistant_chat_message(
    pool: &SqlitePool,
    work_item_id: &str,
    log_id: &str,
    events: &[AcpEventItem],
) -> Result<(), String> {
    let content = extract_assistant_chat_text(events);
    if content.is_empty() {
        return Ok(());
    }

    insert_work_item_chat_message(pool, work_item_id, "assistant", &content, Some(log_id), None)
        .await
        .map(|_| ())
}

async fn persist_user_chat_message(
    app: &AppHandle,
    pool: &SqlitePool,
    work_item_id: &str,
    log_id: &str,
    content: &str,
    created_at: &str,
) -> Result<(), String> {
    if let Some(message) = insert_work_item_chat_message(
        pool,
        work_item_id,
        "user",
        content,
        Some(log_id),
        Some(created_at),
    )
    .await?
    {
        let item = work_item_chat_message_to_event(&message);
        emit_acp_event(app, work_item_id, log_id, &item);
    }

    Ok(())
}

fn render_resume_history(messages: &[WorkItemChatMessage]) -> String {
    const MAX_MESSAGES: usize = 24;
    const MAX_BYTES: usize = 20_000;

    let mut selected: Vec<&WorkItemChatMessage> = Vec::new();
    let mut total_bytes = 0usize;

    for message in messages.iter().rev() {
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }

        let estimated = content.len() + message.role.len() + 8;
        if !selected.is_empty() && (selected.len() >= MAX_MESSAGES || total_bytes + estimated > MAX_BYTES) {
            break;
        }

        selected.push(message);
        total_bytes += estimated;
    }

    selected.reverse();

    let mut out = String::from("Persisted conversation transcript:\n\n");
    for message in selected {
        let label = match message.role.as_str() {
            "system" => "System",
            "assistant" => "Assistant",
            _ => "User",
        };
        out.push_str(label);
        out.push_str(":\n");
        out.push_str(message.content.trim());
        out.push_str("\n\n");
    }

    out.trim_end().to_string()
}

async fn build_resume_turn_request(
    pool: &SqlitePool,
    work_item_id: &str,
    message: &str,
) -> Result<AgentTurnRequest, String> {
    let history = list_work_item_chat_messages(pool, work_item_id).await?;
    if history.is_empty() {
        return build_turn_request(pool, work_item_id, Some(message.to_string())).await;
    }

    let mut request = build_agent_turn_request_base(pool, work_item_id).await?;
    let history_block = render_resume_history(&history);
    request.prompt = format!(
        "Resume the existing work item conversation. The prior live session is unavailable, so continue this same conversation from the persisted transcript below and the current worktree state. Do not restart from scratch.\n\n{history_block}\n\nContinue from the current worktree state.\n\nNew user message:\n{}",
        message.trim()
    );

    Ok(request)
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

async fn apply_session_policy(
    handle: &ActiveSessionHandle,
    permission_policy: Option<AgentPermissionPolicy>,
) {
    if let Some(policy) = permission_policy {
        let _ = handle.shared.update_snapshot(|state| {
            state.permission_policy = policy.clone();
            state.last_activity_at = now_iso();
            state.idle_deadline_at = idle_deadline_iso();
        });
        handle.shared.emit_state();
        let _ = touch_session(handle).await;
    }
}

async fn finalize_start_failure(
    app: AppHandle,
    work_item_id: String,
    pool: &SqlitePool,
    log_id: &str,
    message: String,
) {
    append_error_event(&app, pool, &work_item_id, log_id, &message).await;
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

async fn start_agent_run_from_request(
    app: AppHandle,
    pool: &SqlitePool,
    request: AgentTurnRequest,
    slot: u8,
    active_sessions: State<'_, ActiveSessions>,
    permission_policy: Option<AgentPermissionPolicy>,
    bootstrap_prompt: Option<String>,
) -> Result<String, String> {
    let log_id = insert_agent_log(pool, &request.work_item_id, &request.agent_id).await?;
    let work_item_id = request.work_item_id.clone();

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

    if let Some(prompt) = bootstrap_prompt {
        let _ = ensure_work_item_chat_bootstrap(pool, &work_item_id, &prompt).await;
    }

    Ok(log_id)
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
    let request = build_turn_request(pool, &work_item_id, extra_instruction.clone()).await?;
    let bootstrap_prompt = if extra_instruction.is_none() {
        Some(request.prompt.clone())
    } else {
        None
    };

    start_agent_run_from_request(
        app,
        pool,
        request,
        slot,
        active_sessions,
        permission_policy,
        bootstrap_prompt,
    )
    .await
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
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Follow-up message is empty".to_string());
    }

    if let Some(handle) = get_session_handle(active_sessions.inner(), &work_item_id)? {
        handle.set_slot(slot);
        apply_session_policy(&handle, permission_policy).await;

        if handle.shared.snapshot().is_running {
            cancel_turn(&handle).await?;
        }

        let _ = ensure_work_item_chat_bootstrap_from_work_item(db.inner(), &work_item_id).await;
        let log_id = insert_agent_log(db.inner(), &work_item_id, &handle.shared.agent_id).await?;
        let message_ts = now_iso();
        start_turn(&handle, log_id.clone(), trimmed_message.to_string()).await?;
        let _ = persist_user_chat_message(
            &app,
            db.inner(),
            &work_item_id,
            &log_id,
            trimmed_message,
            &message_ts,
        )
        .await;
        return Ok(log_id);
    }

    if !work_item_has_resume_history(db.inner(), &work_item_id).await? {
        return Err("Start the work item first to open the initial agent conversation.".to_string());
    }

    let request = build_resume_turn_request(db.inner(), &work_item_id, trimmed_message).await?;
    let message_ts = now_iso();
    let log_id = start_agent_run_from_request(
        app.clone(),
        db.inner(),
        request,
        slot,
        active_sessions,
        permission_policy,
        None,
    )
    .await?;

    let _ = ensure_work_item_chat_bootstrap_from_work_item(db.inner(), &work_item_id).await;
    let _ = persist_user_chat_message(
        &app,
        db.inner(),
        &work_item_id,
        &log_id,
        trimmed_message,
        &message_ts,
    )
    .await;
    Ok(log_id)
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
        pool: pool.clone(),
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
        current_log_seq: Arc::new(Mutex::new(0)),
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
                let stderr = {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    stderr_task.await.unwrap_or_default()
                };
                let message = format_acp_startup_error(
                    format!("ACP initialize failed: {}", err.message),
                    stderr,
                );
                let _ = ready_tx.send(Err(message));
                return;
            }

            let session = match connection
                .new_session(NewSessionRequest::new(request.worktree_path.clone()))
                .await
            {
                Ok(session) => session,
                Err(err) => {
                    let stderr = {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        stderr_task.await.unwrap_or_default()
                    };
                    let message = format_acp_startup_error(
                        format!("ACP session creation failed: {}", err.message),
                        stderr,
                    );
                    let _ = ready_tx.send(Err(message));
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
                                    append_error_event(&app, &pool, &request.work_item_id, &log_id, "ACP run completed without output").await;
                                } else if let Some(message) = turn.error_summary.as_deref() {
                                    append_error_event(&app, &pool, &request.work_item_id, &log_id, message).await;
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

async fn append_error_event(
    app: &AppHandle,
    pool: &SqlitePool,
    work_item_id: &str,
    log_id: &str,
    message: &str,
) {
    let item = AcpEventItem {
        id: Ulid::new().to_string(),
        seq: 0,
        kind: "error".to_string(),
        content: Some(message.to_string()),
        tool_name: None,
        tool_input: None,
        tool_call_id: None,
        ts: now_iso(),
    };
    let fallback = item.clone();
    let item = append_agent_log_event(pool, log_id, item).await.unwrap_or(fallback);
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
    let _ = persist_assistant_chat_message(pool, work_item_id, log_id, events).await;

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
    let persisted_events = get_log_events(db.inner(), &log_id).await?;
    if !persisted_events.is_empty() {
        return Ok(persisted_events);
    }

    let row = sqlx::query("SELECT messages FROM agent_logs WHERE id = ?")
        .bind(&log_id)
        .fetch_optional(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    let messages_json: Option<String> = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("messages").ok().flatten());

    match messages_json {
        Some(json) => serde_json::from_str(&json)
            .map(normalize_legacy_events)
            .map_err(|e| e.to_string()),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn get_work_item_acp_events(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<Vec<AcpEventItem>, String> {
    let rows = sqlx::query(
        "SELECT id, messages FROM agent_logs WHERE work_item_id = ? ORDER BY created_at ASC",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        let log_id: String = row.try_get("id").map_err(|e| e.to_string())?;
        let event_rows = get_log_events(db.inner(), &log_id).await?;
        if !event_rows.is_empty() {
            items.extend(event_rows);
            continue;
        }

        let messages_json: Option<String> = row.try_get("messages").ok().flatten();
        if let Some(json) = messages_json {
            let legacy: Vec<AcpEventItem> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            items.extend(normalize_legacy_events(legacy));
        }
    }

    let chat_messages = sqlx::query_as::<_, WorkItemChatMessage>(
        "SELECT id, work_item_id, role, content, agent_log_id, created_at \
         FROM work_item_chat_messages WHERE work_item_id = ? AND role = 'user' ORDER BY created_at ASC",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    items.extend(chat_messages.iter().map(work_item_chat_message_to_event));
    items.sort_by(|a, b| {
        a.ts.cmp(&b.ts)
            .then_with(|| {
                let rank = |kind: &str| match kind {
                    "user_message" => 0,
                    "tool_call" => 1,
                    "tool_result" => 2,
                    "text" | "text_delta" => 3,
                    "error" => 4,
                    "done" => 5,
                    _ => 6,
                };
                rank(&a.kind).cmp(&rank(&b.kind))
            })
            .then_with(|| a.seq.cmp(&b.seq))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(items)
}
