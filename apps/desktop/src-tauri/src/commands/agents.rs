use agent_client_protocol::{
    Agent, Client, ClientCapabilities, ClientSideConnection, ContentBlock, Error as AcpError,
    FileSystemCapability, Implementation, InitializeRequest, NewSessionRequest, PromptRequest,
    ProtocolVersion, ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest,
    RequestPermissionResponse, RequestPermissionOutcome, Result as AcpResult,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason, WriteTextFileRequest,
    WriteTextFileResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::AsyncReadExt,
    process::Command,
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
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentLog {
    pub id: String,
    pub ticket_id: String,
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
            ticket_id: row.try_get("ticket_id")?,
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

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[derive(Clone)]
struct AcpClientHandler {
    app: AppHandle,
    ticket_id: String,
    log_id: String,
    worktree_root: PathBuf,
    events: Arc<Mutex<Vec<AcpEventItem>>>,
}

impl AcpClientHandler {
    fn push_item(&self, item: AcpEventItem) {
        if let Ok(mut events) = self.events.lock() {
            events.push(item.clone());
        }
        emit_acp_event(&self.app, &self.ticket_id, &self.log_id, &item);
    }

    fn event_len(&self) -> usize {
        self.events.lock().map(|events| events.len()).unwrap_or(0)
    }

    fn validate_path(&self, path: &Path) -> AcpResult<()> {
        if !path.is_absolute() {
            return Err(AcpError::invalid_params().data("Path must be absolute"));
        }

        if !path.starts_with(&self.worktree_root) {
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
        let option = args
            .options
            .first()
            .ok_or_else(|| AcpError::invalid_params().data("No permission options provided"))?;

        Ok(RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            )),
        ))
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

fn extract_file_references(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }

        let start = i + 1;
        let mut end = start;
        while end < chars.len() {
            let ch = chars[end];
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '\\') {
                end += 1;
            } else {
                break;
            }
        }

        if end > start {
            let candidate: String = chars[start..end].iter().collect();
            if !refs.iter().any(|existing| existing == &candidate) {
                refs.push(candidate);
            }
        }

        i = end.max(i + 1);
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

// ─── Agent Config Commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_agent_configs(db: State<'_, SqlitePool>) -> Result<Vec<AgentConfig>, String> {
    sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled \
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
) -> Result<AgentConfig, String> {
    let max_concurrent = max_concurrent.unwrap_or(1);
    let enabled = enabled.unwrap_or(1);

    sqlx::query(
        r#"INSERT INTO agent_config
             (id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name   = excluded.display_name,
             acp_url        = excluded.acp_url,
             api_key_ref    = excluded.api_key_ref,
             model          = excluded.model,
             max_concurrent = excluded.max_concurrent,
             enabled        = excluded.enabled"#,
    )
    .bind(&id)
    .bind(&display_name)
    .bind(&acp_url)
    .bind(&api_key_ref)
    .bind(&model)
    .bind(max_concurrent)
    .bind(enabled)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled \
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

async fn start_agent_run(
    app: AppHandle,
    pool: &SqlitePool,
    ticket_id: String,
    extra_instruction: Option<String>,
) -> Result<String, String> {
    let row = sqlx::query(
        "SELECT context, worktree_path, assigned_agent FROM tickets WHERE id = ?",
    )
    .bind(&ticket_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Ticket {} not found", ticket_id))?;

    let context: Option<String> = row.try_get("context").ok().flatten();
    let worktree_path: Option<String> = row.try_get("worktree_path").ok().flatten();
    let assigned_agent: Option<String> = row.try_get("assigned_agent").ok().flatten();

    let worktree_path =
        worktree_path.ok_or("Ticket has no worktree_path; run create_worktree first")?;
    let agent_id = assigned_agent.ok_or("Ticket has no assigned_agent")?;

    let agent = sqlx::query_as::<_, AgentConfig>(
        "SELECT id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled \
         FROM agent_config WHERE id = ?",
    )
    .bind(&agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Agent config '{}' not found", agent_id))?;

    let base_prompt = context
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Ticket is missing 'What Should Be Done'".to_string())?;
    let full_prompt = match extra_instruction {
        Some(message) if !message.trim().is_empty() => format!(
            "{base_prompt}\n\nContinue from the current worktree state.\n\nFollow-up user message:\n{}",
            message.trim()
        ),
        _ => base_prompt,
    };
    let full_prompt = expand_prompt_with_file_refs(&full_prompt, &worktree_path)?;

    let log_id = Ulid::new().to_string();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO agent_logs (id, ticket_id, agent_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&log_id)
    .bind(&ticket_id)
    .bind(&agent_id)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    let api_key = agent
        .api_key_ref
        .as_deref()
        .and_then(|var| std::env::var(var).ok());
    let api_key_ref = agent.api_key_ref.clone();

    let pool_bg = pool.clone();
    let ticket_id_bg = ticket_id.clone();
    let log_id_bg = log_id.clone();
    let agent_name = agent_id.clone();

    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(err) => {
                let message = format!("Failed to create ACP runtime: {err}");
                emit_error_event(&app, &ticket_id_bg, &log_id_bg, &message);
                return;
            }
        };

        runtime.block_on(run_acp_agent(
            app,
            pool_bg,
            ticket_id_bg,
            log_id_bg,
            agent.acp_url,
            agent_name,
            full_prompt,
            worktree_path,
            api_key_ref,
            api_key,
            agent.model,
        ));
    });

    Ok(log_id)
}

/// Launch an ACP agent run for a ticket.
/// Creates a placeholder log entry, then spawns a background task that opens
/// an ACP stdio session. Returns the log_id immediately.
#[tauri::command]
pub async fn launch_agent(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
    slot: u8,
) -> Result<String, String> {
    let _ = slot; // slot is retained for UI tracking; ACP doesn't need it
    start_agent_run(app, db.inner(), ticket_id, None).await
}

/// Continue an ACP agent run for a ticket with a follow-up user message.
#[tauri::command]
pub async fn continue_agent(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
    slot: u8,
    message: String,
) -> Result<String, String> {
    let _ = slot; // slot is retained for UI tracking; ACP doesn't need it
    start_agent_run(app, db.inner(), ticket_id, Some(message)).await
}

// ─── ACP Streaming Run ────────────────────────────────────────────────────────

async fn run_acp_agent(
    app: AppHandle,
    pool: SqlitePool,
    ticket_id: String,
    log_id: String,
    acp_target: String,
    agent_name: String,
    prompt: String,
    worktree_path: String,
    api_key_ref: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) {
    let start = Instant::now();
    let _ = model;

    let target = match resolve_transport_target(&agent_name, &acp_target) {
        Ok(target) => target,
        Err(err) => {
            emit_error_event(&app, &ticket_id, &log_id, &err);
            finalize(
                &app,
                &pool,
                &ticket_id,
                &log_id,
                None,
                &[],
                None,
                None,
                1,
                start.elapsed().as_millis() as i64,
                Some(err),
                false,
                None,
            )
            .await;
            return;
        }
    };

    let worktree_root = PathBuf::from(&worktree_path);
    let handler = AcpClientHandler {
        app: app.clone(),
        ticket_id: ticket_id.clone(),
        log_id: log_id.clone(),
        worktree_root,
        events: Arc::new(Mutex::new(Vec::new())),
    };

    let (
        run_id,
        tokens_in,
        tokens_out,
        exit_code,
        error_summary,
        cleanup_warning,
        cleanup_warning_message,
    ) =
        tokio::task::LocalSet::new()
            .run_until(async {
                let mut command = match build_command(
                    &target,
                    &worktree_path,
                    api_key_ref.as_deref(),
                    api_key.as_deref(),
                ) {
                    Ok(command) => command,
                    Err(err) => return (None, None, None, 1, Some(err), false, None),
                };

                let mut child = match command.spawn() {
                    Ok(child) => child,
                    Err(err) => {
                        return (
                            None,
                            None,
                            None,
                            1,
                            Some(format!("Failed to start ACP agent '{target}': {err}")),
                            false,
                            None,
                        )
                    }
                };

                let child_stdin = match child.stdin.take() {
                    Some(stdin) => stdin,
                    None => return (None, None, None, 1, Some("ACP agent stdin unavailable".to_string()), false, None),
                };
                let child_stdout = match child.stdout.take() {
                    Some(stdout) => stdout,
                    None => return (None, None, None, 1, Some("ACP agent stdout unavailable".to_string()), false, None),
                };
                let mut child_stderr = child.stderr.take();

                let stderr_task = tokio::task::spawn_local(async move {
                    let mut stderr = Vec::new();
                    if let Some(mut stream) = child_stderr.take() {
                        let _ = stream.read_to_end(&mut stderr).await;
                    }
                    String::from_utf8_lossy(&stderr).trim().to_string()
                });

                let (connection, io_task) = ClientSideConnection::new(
                    handler.clone(),
                    child_stdin.compat_write(),
                    child_stdout.compat(),
                    |fut| {
                        tokio::task::spawn_local(fut);
                    },
                );
                tokio::task::spawn_local(async move {
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
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    let stderr = stderr_task.await.unwrap_or_default();
                    return (
                        None,
                        None,
                        None,
                        1,
                        Some(if stderr.is_empty() {
                            format!("ACP initialize failed: {}", err.message)
                        } else {
                            format!("ACP initialize failed: {} ({stderr})", err.message)
                        }),
                        false,
                        None,
                    );
                }

                let session = match connection
                    .new_session(NewSessionRequest::new(worktree_path.clone()))
                    .await
                {
                    Ok(session) => session,
                    Err(err) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        let stderr = stderr_task.await.unwrap_or_default();
                        return (
                            None,
                            None,
                            None,
                            1,
                            Some(if stderr.is_empty() {
                                format!("ACP session creation failed: {}", err.message)
                            } else {
                                format!("ACP session creation failed: {} ({stderr})", err.message)
                            }),
                            false,
                            None,
                        );
                    }
                };

                let prompt_result = connection
                    .prompt(PromptRequest::new(
                        session.session_id.clone(),
                        vec![ContentBlock::from(prompt.clone())],
                    ))
                    .await;
                drop(connection);
                let status = match timeout(Duration::from_secs(5), child.wait()).await {
                    Ok(Ok(status)) => status,
                    Ok(Err(err)) => {
                        return (
                            Some(session.session_id.to_string()),
                            None,
                            None,
                            1,
                            Some(format!("ACP agent wait failed: {err}")),
                            false,
                            None,
                        )
                    }
                    Err(_) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        let warning = "ACP agent did not exit after prompt completion".to_string();
                        match &prompt_result {
                            Ok(response) if response.stop_reason == StopReason::EndTurn => {
                                return (
                                    Some(session.session_id.to_string()),
                                    None,
                                    None,
                                    0,
                                    None,
                                    true,
                                    Some(warning),
                                );
                            }
                            _ => {
                                return (
                                    Some(session.session_id.to_string()),
                                    None,
                                    None,
                                    1,
                                    Some(warning),
                                    false,
                                    None,
                                );
                            }
                        }
                    }
                };
                let stderr = stderr_task.await.unwrap_or_default();

                match prompt_result {
                    Ok(response) => {
                        let mut exit_code = if status.success() { 0 } else { 1 };
                        let mut summary = if stderr.is_empty() { None } else { Some(stderr) };

                        if response.stop_reason != StopReason::EndTurn {
                            exit_code = 1;
                            let reason = format!("Agent stopped with {:?}", response.stop_reason);
                            summary = Some(match summary {
                                Some(stderr) => format!("{reason}. {stderr}"),
                                None => reason,
                            });
                        }

                        (
                            Some(session.session_id.to_string()),
                            None,
                            None,
                            exit_code,
                            summary,
                            false,
                            None,
                        )
                    }
                    Err(err) => {
                        let msg = if stderr.is_empty() {
                            format!("ACP prompt failed: {}", err.message)
                        } else {
                            format!("ACP prompt failed: {} ({stderr})", err.message)
                        };
                        (
                            Some(session.session_id.to_string()),
                            None,
                            None,
                            1,
                            Some(msg),
                            false,
                            None,
                        )
                    }
                }
            })
            .await;

    let events = handler
        .events
        .lock()
        .map(|events| events.clone())
        .unwrap_or_default();

    if exit_code == 0 && events.is_empty() && handler.event_len() == 0 {
        emit_error_event(&app, &ticket_id, &log_id, "ACP run completed without output");
    } else if let Some(message) = error_summary.as_deref() {
        emit_error_event(&app, &ticket_id, &log_id, message);
    }

    finalize(
        &app,
        &pool,
        &ticket_id,
        &log_id,
        run_id.as_deref(),
        &events,
        tokens_in,
        tokens_out,
        exit_code,
        start.elapsed().as_millis() as i64,
        error_summary,
        cleanup_warning,
        cleanup_warning_message,
    )
    .await;
}

fn emit_error_event(app: &AppHandle, ticket_id: &str, log_id: &str, message: &str) {
    let item = AcpEventItem {
        id: Ulid::new().to_string(),
        kind: "error".to_string(),
        content: Some(message.to_string()),
        tool_name: None,
        tool_input: None,
        tool_call_id: None,
        ts: now_iso(),
    };
    emit_acp_event(app, ticket_id, log_id, &item);
}

fn emit_acp_event(app: &AppHandle, ticket_id: &str, log_id: &str, item: &AcpEventItem) {
    let _ = app.emit(
        "acp:event",
        serde_json::json!({
            "ticketId": ticket_id,
            "logId": log_id,
            "item": item,
        }),
    );
}

async fn finalize(
    app: &AppHandle,
    pool: &SqlitePool,
    ticket_id: &str,
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
            "UPDATE tickets SET status = ?, completed_at = ?, updated_at = ?, terminal_slot = NULL \
             WHERE id = ? AND status = 'running'",
        )
        .bind(to_status)
        .bind(&now)
        .bind(&now)
        .bind(ticket_id)
        .execute(pool)
        .await;
    } else {
        let _ = sqlx::query(
            "UPDATE tickets SET status = ?, completed_at = ?, updated_at = ? \
             WHERE id = ? AND status = 'running'",
        )
        .bind(to_status)
        .bind(&now)
        .bind(&now)
        .bind(ticket_id)
        .execute(pool)
        .await;
    }

    let _ = app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": ticket_id,
            "from": "running",
            "to": to_status,
        }),
    );
}

// ─── Agent Log Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_agent_logs(
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<Vec<AgentLog>, String> {
    sqlx::query_as::<_, AgentLog>(
        "SELECT id, ticket_id, agent_id, run_id, messages, summary, tokens_in, tokens_out, \
         cost_usd, exit_code, duration_ms, cleanup_warning, cleanup_warning_message, created_at \
         FROM agent_logs WHERE ticket_id = ? ORDER BY created_at DESC",
    )
    .bind(&ticket_id)
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
