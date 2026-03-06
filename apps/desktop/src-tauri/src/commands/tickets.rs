use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteArguments, Arguments, Row, SqlitePool};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Ticket {
    pub id: String,
    pub title: String,
    pub context: Option<String>,
    pub status: String,
    pub repo_path: Option<String>,
    pub source_branch: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub assigned_agent: Option<String>,
    pub terminal_slot: Option<i64>,
    pub workspace_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for Ticket {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(Ticket {
            id: row.try_get("id")?,
            title: row.try_get("title")?,
            context: row.try_get("context")?,
            status: row.try_get("status")?,
            repo_path: row.try_get("repo_path")?,
            source_branch: row.try_get("source_branch")?,
            branch_name: row.try_get("branch_name")?,
            worktree_path: row.try_get("worktree_path")?,
            assigned_agent: row.try_get("assigned_agent")?,
            terminal_slot: row.try_get("terminal_slot")?,
            workspace_id: row.try_get::<String, _>("workspace_id").unwrap_or_else(|_| "default".to_string()),
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            started_at: row.try_get("started_at")?,
            completed_at: row.try_get("completed_at")?,
        })
    }
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn status_weight(status: &str) -> i32 {
    match status {
        "running" => 0,
        "review" => 1,
        "queued" => 2,
        "blocked" => 3,
        "ready" => 4,
        "draft" => 5,
        "done" => 6,
        "archived" => 7,
        _ => 99,
    }
}

fn is_valid_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("draft", "ready")
            | ("ready", "queued")
            | ("ready", "blocked")
            | ("ready", "draft")
            | ("ready", "review")
            | ("ready", "running")
            | ("blocked", "ready")
            | ("blocked", "queued")
            | ("queued", "running")
            | ("queued", "ready")
            | ("running", "review")
            | ("running", "ready")
            | ("review", "running")
            | ("review", "done")
            | ("review", "ready")
            | ("done", "archived")
    )
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".idea"
            | ".vscode"
    )
}

fn score_path(path: &str, query: &str) -> i32 {
    if query.is_empty() {
        return path.matches('/').count() as i32;
    }

    let path_lc = path.to_lowercase();
    let query_lc = query.to_lowercase();
    let file_name = path_lc.rsplit('/').next().unwrap_or(&path_lc);

    if file_name == query_lc {
        return 0;
    }
    if file_name.starts_with(&query_lc) {
        return 10;
    }
    if path_lc.starts_with(&query_lc) {
        return 20;
    }
    if file_name.contains(&query_lc) {
        return 30;
    }
    if path_lc.contains(&query_lc) {
        return 40;
    }

    100 + path.matches('/').count() as i32
}

fn collect_repo_files(
    root: &Path,
    current: &Path,
    query: &str,
    matches: &mut Vec<String>,
    visited: &mut usize,
    max_visited: usize,
) {
    if *visited >= max_visited {
        return;
    }

    let entries = match std::fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if *visited >= max_visited {
            return;
        }

        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        let name = entry.file_name();
        let name = name.to_string_lossy();

        if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            collect_repo_files(root, &path, query, matches, visited, max_visited);
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        *visited += 1;

        let rel = match path.strip_prefix(root) {
            Ok(rel) => rel,
            Err(_) => continue,
        };

        let rel = rel.to_string_lossy().replace('\\', "/");
        if query.is_empty() || rel.to_lowercase().contains(&query.to_lowercase()) {
            matches.push(rel);
        }
    }
}

const SELECT_COLS: &str = r#"
    SELECT id, title, context, status,
           repo_path, source_branch, branch_name, worktree_path, assigned_agent, terminal_slot,
           workspace_id, created_at, updated_at, started_at, completed_at
    FROM tickets
"#;

async fn fetch_ticket(pool: &SqlitePool, id: &str) -> Result<Ticket, String> {
    let sql = format!("{} WHERE id = ?", SELECT_COLS);
    sqlx::query_as::<_, Ticket>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Ticket {} not found", id))
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_ticket(
    db: State<'_, SqlitePool>,
    title: String,
    context: Option<String>,
    repo_path: Option<String>,
    assigned_agent: Option<String>,
    branch_name: Option<String>,
    source_branch: Option<String>,
    workspace_id: Option<String>,
) -> Result<Ticket, String> {
    let id = Ulid::new().to_string();
    let now = now_iso();
    let workspace_id = workspace_id.unwrap_or_else(|| "default".to_string());
    let assigned_agent = assigned_agent
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some("claude-code".to_string()));
    let branch_name = branch_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let source_branch = source_branch
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    sqlx::query(
        r#"INSERT INTO tickets (
            id, title, context, status, repo_path, source_branch, branch_name, worktree_path,
            assigned_agent, terminal_slot, workspace_id, created_at, updated_at,
            started_at, completed_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL)"#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&context)
    .bind(&repo_path)
    .bind(&source_branch)
    .bind(&branch_name)
    .bind(&assigned_agent)
    .bind(&workspace_id)
    .bind(&now)
    .bind(&now)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    fetch_ticket(db.inner(), &id).await
}

#[tauri::command]
pub async fn update_ticket(
    db: State<'_, SqlitePool>,
    id: String,
    fields: Value,
) -> Result<Ticket, String> {
    let current = fetch_ticket(db.inner(), &id).await?;

    if current.status == "running" {
        return Err("Cannot update a ticket that is currently running".to_string());
    }

    let allowed_fields = [
        "title",
        "context",
        "repo_path",
        "source_branch",
        "branch_name",
        "worktree_path",
        "assigned_agent",
        "terminal_slot",
    ];

    let obj = fields.as_object().ok_or("fields must be a JSON object")?;
    if obj.is_empty() {
        return Ok(current);
    }

    let now = now_iso();
    let mut set_clauses: Vec<String> = vec!["updated_at = ?".to_string()];
    let mut args = SqliteArguments::default();
    let _ = args.add(now);

    for field in &allowed_fields {
        if let Some(val) = obj.get(*field) {
            set_clauses.push(format!("{} = ?", field));
            match val {
                Value::String(s) => { let _ = args.add(Some(s.clone())); }
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        let _ = args.add(i);
                    } else {
                        let _ = args.add(n.as_f64().unwrap_or(0.0));
                    }
                }
                Value::Null => { let _ = args.add(Option::<String>::None); }
                Value::Bool(b) => { let _ = args.add(*b as i64); }
                _ => { let _ = args.add(val.to_string()); }
            }
        }
    }

    let _ = args.add(id.clone());

    let sql = format!(
        "UPDATE tickets SET {} WHERE id = ?",
        set_clauses.join(", ")
    );
    sqlx::query_with(&sql, args)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    fetch_ticket(db.inner(), &id).await
}

#[tauri::command]
pub async fn list_tickets(
    db: State<'_, SqlitePool>,
    status_filter: Option<Vec<String>>,
    workspace_id: Option<String>,
) -> Result<Vec<Ticket>, String> {
    let ws = workspace_id.unwrap_or_else(|| "default".to_string());

    let mut tickets = if let Some(statuses) = status_filter.filter(|s| !s.is_empty()) {
        let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "{} WHERE workspace_id = ? AND status IN ({}) ORDER BY updated_at DESC",
            SELECT_COLS, placeholders
        );
        let mut q = sqlx::query_as::<_, Ticket>(&sql).bind(&ws);
        for s in &statuses {
            q = q.bind(s);
        }
        q.fetch_all(db.inner()).await.map_err(|e| e.to_string())?
    } else {
        let sql = format!("{} WHERE workspace_id = ? ORDER BY updated_at DESC", SELECT_COLS);
        sqlx::query_as::<_, Ticket>(&sql)
            .bind(&ws)
            .fetch_all(db.inner())
            .await
            .map_err(|e| e.to_string())?
    };

    tickets.sort_by(|a, b| {
        let wa = status_weight(&a.status);
        let wb = status_weight(&b.status);
        wa.cmp(&wb).then(b.updated_at.cmp(&a.updated_at))
    });

    Ok(tickets)
}

#[tauri::command]
pub async fn get_ticket(db: State<'_, SqlitePool>, id: String) -> Result<Ticket, String> {
    fetch_ticket(db.inner(), &id).await
}

#[tauri::command]
pub async fn transition_ticket(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    id: String,
    to_status: String,
) -> Result<Ticket, String> {
    let ticket = fetch_ticket(db.inner(), &id).await?;
    let from_status = ticket.status.clone();

    if !is_valid_transition(&from_status, &to_status) {
        return Err(format!(
            "Invalid transition: {} → {}",
            from_status, to_status
        ));
    }

    match (from_status.as_str(), to_status.as_str()) {
        ("draft", "ready") => {
            if ticket.title.trim().is_empty() {
                return Err("Title is required to mark ticket as ready".to_string());
            }
            if ticket
                .context
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Context is required to mark ticket as ready".to_string());
            }
            if ticket
                .repo_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Repo path is required to mark ticket as ready".to_string());
            }
        }
        ("ready", "queued") => {
            if ticket
                .assigned_agent
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Assigned agent is required to queue a ticket".to_string());
            }
            if ticket.terminal_slot.is_none() {
                return Err("Terminal slot is required to queue a ticket".to_string());
            }
        }
        ("ready", "review") => {
            if ticket
                .repo_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
                || ticket
                    .worktree_path
                    .as_deref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
                || ticket
                    .branch_name
                    .as_deref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
            {
                return Err("Ticket has no recoverable worktree to review".to_string());
            }
        }
        ("ready", "running") | ("review", "running") => {
            if ticket
                .assigned_agent
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Assigned agent is required to continue a ticket".to_string());
            }
            if ticket.terminal_slot.is_none() {
                return Err("Terminal slot is required to continue a ticket".to_string());
            }
            if ticket
                .worktree_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Worktree path is required to continue a ticket".to_string());
            }
        }
        _ => {}
    }

    let now = now_iso();

    match (from_status.as_str(), to_status.as_str()) {
        ("queued", "running") | ("ready", "running") | ("review", "running") => {
            sqlx::query(
                "UPDATE tickets SET status = ?, started_at = ?, completed_at = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(&to_status)
            .bind(&now)
            .bind(&now)
            .bind(&id)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
        }
        ("running", "review") => {
            sqlx::query(
                "UPDATE tickets SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
            )
            .bind(&to_status)
            .bind(&now)
            .bind(&now)
            .bind(&id)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
        }
        ("ready", "review") => {
            sqlx::query("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?")
                .bind(&to_status)
                .bind(&now)
                .bind(&id)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;
        }
        ("review", "ready") => {
            sqlx::query(
                r#"UPDATE tickets SET
                    status = ?, assigned_agent = NULL, terminal_slot = NULL,
                    started_at = NULL, completed_at = NULL,
                    worktree_path = NULL, source_branch = NULL, branch_name = NULL, updated_at = ?
                WHERE id = ?"#,
            )
            .bind(&to_status)
            .bind(&now)
            .bind(&id)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
        }
        _ => {
            sqlx::query("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?")
                .bind(&to_status)
                .bind(&now)
                .bind(&id)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": id,
            "from": from_status,
            "to": to_status,
        }),
    )
    .map_err(|e| e.to_string())?;

    // When a ticket is approved (done), cascade-unblock any blocked dependents
    if to_status == "done" {
        let _ = cascade_unblock_dependents(&app, db.inner(), &id).await;
    }

    fetch_ticket(db.inner(), &id).await
}

#[tauri::command]
pub async fn archive_ticket(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    id: String,
) -> Result<Ticket, String> {
    let ticket = fetch_ticket(db.inner(), &id).await?;
    if ticket.status != "done" {
        return Err(format!(
            "Can only archive tickets in 'done' state, current state: {}",
            ticket.status
        ));
    }
    transition_ticket(app, db, id, "archived".to_string()).await
}

#[tauri::command]
pub async fn delete_ticket(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    let ticket = fetch_ticket(db.inner(), &id).await?;

    if ticket.status == "running" {
        return Err("Cannot delete a ticket that is currently running".to_string());
    }

    if ticket.worktree_path.is_some() || ticket.branch_name.is_some() {
        return Err("Cannot delete a ticket with an attached worktree. Reject it first.".to_string());
    }

    sqlx::query("DELETE FROM agent_logs WHERE ticket_id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    // Remove all dependency edges involving this ticket
    sqlx::query("DELETE FROM ticket_dependencies WHERE ticket_id = ? OR depends_on_id = ?")
        .bind(&id)
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM tickets WHERE id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": id,
            "from": ticket.status,
            "to": "deleted",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn search_repo_files(
    repo_path: String,
    query: Option<String>,
) -> Result<Vec<String>, String> {
    let query = query.unwrap_or_default().trim().to_string();
    let root = PathBuf::from(&repo_path);

    if repo_path.trim().is_empty() {
        return Ok(Vec::new());
    }

    if !root.is_dir() {
        return Err("Selected repo path does not exist".to_string());
    }

    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("Failed to access selected repo: {e}"))?;

    let mut matches = Vec::new();
    let mut visited = 0usize;
    collect_repo_files(&root, &root, &query, &mut matches, &mut visited, 5000);

    matches.sort_by(|a, b| {
        let sa = score_path(a, &query);
        let sb = score_path(b, &query);
        sa.cmp(&sb).then(a.len().cmp(&b.len())).then(a.cmp(b))
    });
    matches.truncate(12);

    Ok(matches)
}

// ─── Dependency types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TicketDependency {
    pub ticket_id: String,
    pub depends_on_id: String,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for TicketDependency {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(TicketDependency {
            ticket_id: row.try_get("ticket_id")?,
            depends_on_id: row.try_get("depends_on_id")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

// ─── Dependency Commands ──────────────────────────────────────────────────────

/// Check if adding a dependency would create a cycle (DFS from depends_on_id).
async fn would_create_cycle(pool: &SqlitePool, ticket_id: &str, depends_on_id: &str) -> Result<bool, String> {
    // DFS: starting from depends_on_id, follow its own dependencies.
    // If we reach ticket_id, it's a cycle.
    let mut stack = vec![depends_on_id.to_string()];
    let mut visited = std::collections::HashSet::new();

    while let Some(current) = stack.pop() {
        if current == ticket_id {
            return Ok(true);
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        let deps: Vec<(String,)> = sqlx::query_as(
            "SELECT depends_on_id FROM ticket_dependencies WHERE ticket_id = ?",
        )
        .bind(&current)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

        for (dep,) in deps {
            stack.push(dep);
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn add_ticket_dependency(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
    depends_on_id: String,
) -> Result<(), String> {
    if ticket_id == depends_on_id {
        return Err("A ticket cannot depend on itself".to_string());
    }

    // Verify both tickets exist
    let _ = fetch_ticket(db.inner(), &ticket_id).await?;
    let _ = fetch_ticket(db.inner(), &depends_on_id).await?;

    // Check for cycles
    if would_create_cycle(db.inner(), &ticket_id, &depends_on_id).await? {
        return Err("Adding this dependency would create a circular dependency".to_string());
    }

    sqlx::query(
        "INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(&ticket_id)
    .bind(&depends_on_id)
    .bind(now_iso())
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:deps-changed",
        serde_json::json!({ "ticketId": ticket_id }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn remove_ticket_dependency(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
    depends_on_id: String,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on_id = ?",
    )
    .bind(&ticket_id)
    .bind(&depends_on_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:deps-changed",
        serde_json::json!({ "ticketId": ticket_id }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get tickets that this ticket depends on (upstream dependencies).
#[tauri::command]
pub async fn get_ticket_dependencies(
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<Vec<TicketDependency>, String> {
    sqlx::query_as::<_, TicketDependency>(
        "SELECT ticket_id, depends_on_id, created_at FROM ticket_dependencies WHERE ticket_id = ? ORDER BY created_at",
    )
    .bind(&ticket_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Get tickets that depend on this ticket (downstream dependents).
#[tauri::command]
pub async fn get_ticket_dependents(
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<Vec<TicketDependency>, String> {
    sqlx::query_as::<_, TicketDependency>(
        "SELECT ticket_id, depends_on_id, created_at FROM ticket_dependencies WHERE depends_on_id = ? ORDER BY created_at",
    )
    .bind(&ticket_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Check if a ticket has unmet dependencies (any dependency not in done/archived).
#[tauri::command]
pub async fn has_unmet_dependencies(
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<bool, String> {
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM ticket_dependencies td \
         JOIN tickets t ON t.id = td.depends_on_id \
         WHERE td.ticket_id = ? AND t.status NOT IN ('done', 'archived')",
    )
    .bind(&ticket_id)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(count.0 > 0)
}

/// After a ticket is approved (done), find blocked dependents that are now unblocked
/// and transition them to ready. Returns the list of unblocked ticket IDs.
pub async fn cascade_unblock_dependents(
    app: &AppHandle,
    pool: &SqlitePool,
    approved_ticket_id: &str,
) -> Result<Vec<String>, String> {
    // Find all blocked tickets that depend on the approved ticket
    let blocked_dependents: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT td.ticket_id FROM ticket_dependencies td \
         JOIN tickets t ON t.id = td.ticket_id \
         WHERE td.depends_on_id = ? AND t.status = 'blocked'",
    )
    .bind(approved_ticket_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let now = now_iso();
    let mut unblocked = Vec::new();

    for (dep_ticket_id,) in blocked_dependents {
        // Check if ALL dependencies of this ticket are now done/archived
        let unmet: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM ticket_dependencies td \
             JOIN tickets t ON t.id = td.depends_on_id \
             WHERE td.ticket_id = ? AND t.status NOT IN ('done', 'archived')",
        )
        .bind(&dep_ticket_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

        if unmet.0 == 0 {
            // All deps met — unblock to ready
            sqlx::query("UPDATE tickets SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'blocked'")
                .bind(&now)
                .bind(&dep_ticket_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit(
                "ticket:state-change",
                serde_json::json!({
                    "ticketId": dep_ticket_id,
                    "from": "blocked",
                    "to": "ready",
                }),
            );

            unblocked.push(dep_ticket_id);
        }
    }

    if !unblocked.is_empty() {
        let _ = app.emit(
            "ticket:deps-unblocked",
            serde_json::json!({ "ticketIds": unblocked }),
        );
    }

    Ok(unblocked)
}
