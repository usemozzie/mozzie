use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteArguments, Arguments, Row, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

use crate::commands::agents::{shutdown_work_item_session, ActiveSessions};
use crate::commands::worktree::{create_worktree, ensure_top_level_worktree, remove_worktree_internal};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    pub context: Option<String>,
    pub execution_context: Option<String>,
    pub orchestrator_note: Option<String>,
    pub duplicate_of_work_item_id: Option<String>,
    pub duplicate_policy: Option<String>,
    pub intent_type: Option<String>,
    pub status: String,
    pub repo_path: Option<String>,
    pub source_branch: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub assigned_agent: Option<String>,
    pub terminal_slot: Option<i64>,
    pub parent_id: Option<String>,
    pub workspace_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for WorkItem {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(WorkItem {
            id: row.try_get("id")?,
            title: row.try_get("title")?,
            context: row.try_get("context")?,
            execution_context: row.try_get("execution_context")?,
            orchestrator_note: row.try_get("orchestrator_note")?,
            duplicate_of_work_item_id: row.try_get("duplicate_of_work_item_id")?,
            duplicate_policy: row.try_get("duplicate_policy")?,
            intent_type: row.try_get("intent_type")?,
            status: row.try_get("status")?,
            repo_path: row.try_get("repo_path")?,
            source_branch: row.try_get("source_branch")?,
            branch_name: row.try_get("branch_name")?,
            worktree_path: row.try_get("worktree_path")?,
            assigned_agent: row.try_get("assigned_agent")?,
            terminal_slot: row.try_get("terminal_slot")?,
            parent_id: row.try_get("parent_id").ok().flatten(),
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

fn should_shutdown_session_for_transition(from: &str, to: &str) -> bool {
    matches!((from, to), ("running", "ready") | ("review", "ready"))
        || matches!(to, "done" | "archived")
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

struct RepoFileCacheEntry {
    files: Vec<String>,
    cached_at: Instant,
}

static REPO_FILE_CACHE: LazyLock<Mutex<HashMap<String, RepoFileCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const REPO_FILE_CACHE_TTL: Duration = Duration::from_secs(5);

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
            collect_repo_files(root, &path, matches, visited, max_visited);
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
        matches.push(rel);
    }
}

fn list_rg_repo_files(root: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("rg")
        .current_dir(root)
        .args([
            "--files",
            "--hidden",
            "--glob",
            "!.git",
            "--glob",
            "!node_modules",
            "--glob",
            "!target",
            "--glob",
            "!dist",
            "--glob",
            "!build",
            "--glob",
            "!.next",
            "--glob",
            "!.turbo",
        ])
        .output()
        .map_err(|e| format!("Failed to list repo files with rg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("rg error: {stderr}"));
    }

    let files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.replace('\\', "/"))
        .collect();

    Ok(files)
}

fn list_git_repo_files(root: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .output()
        .map_err(|e| format!("Failed to list repo files: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git error: {stderr}"));
    }

    let files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            Some(String::from_utf8_lossy(entry).replace('\\', "/"))
        })
        .collect();

    Ok(files)
}

fn list_repo_files(root: &Path) -> Vec<String> {
    if let Ok(files) = list_rg_repo_files(root) {
        return files;
    }

    if let Ok(files) = list_git_repo_files(root) {
        return files;
    }

    let mut matches = Vec::new();
    let mut visited = 0usize;
    collect_repo_files(root, root, &mut matches, &mut visited, 20_000);
    matches
}

fn load_repo_files(root: &Path) -> Vec<String> {
    let cache_key = root.to_string_lossy().to_string();

    if let Ok(cache) = REPO_FILE_CACHE.lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.cached_at.elapsed() <= REPO_FILE_CACHE_TTL {
                return entry.files.clone();
            }
        }
    }

    let files = list_repo_files(root);

    if let Ok(mut cache) = REPO_FILE_CACHE.lock() {
        cache.insert(
            cache_key,
            RepoFileCacheEntry {
                files: files.clone(),
                cached_at: Instant::now(),
            },
        );
    }

    files
}

const SELECT_COLS: &str = r#"
    SELECT id, title, context, execution_context, orchestrator_note, duplicate_of_work_item_id, duplicate_policy, intent_type, status,
           repo_path, source_branch, branch_name, worktree_path, assigned_agent, terminal_slot,
           parent_id, workspace_id, created_at, updated_at, started_at, completed_at
    FROM work_items
"#;

async fn fetch_work_item(pool: &SqlitePool, id: &str) -> Result<WorkItem, String> {
    let sql = format!("{} WHERE id = ?", SELECT_COLS);
    sqlx::query_as::<_, WorkItem>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Work item {} not found", id))
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_work_item(
    db: State<'_, SqlitePool>,
    title: String,
    context: Option<String>,
    execution_context: Option<String>,
    orchestrator_note: Option<String>,
    repo_path: Option<String>,
    assigned_agent: Option<String>,
    branch_name: Option<String>,
    source_branch: Option<String>,
    duplicate_of_work_item_id: Option<String>,
    duplicate_policy: Option<String>,
    intent_type: Option<String>,
    parent_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<WorkItem, String> {
    let id = Ulid::new().to_string();
    let now = now_iso();
    let workspace_id = workspace_id.unwrap_or_else(|| "default".to_string());
    let repo_path = repo_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let assigned_agent = assigned_agent
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut branch_name = branch_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut source_branch = source_branch
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let parent_id = parent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let initial_status = if repo_path.is_some() && assigned_agent.is_some() {
        "ready"
    } else {
        "draft"
    };

    // Validate parent: must exist and must not itself be a child (single-level nesting only).
    if let Some(ref pid) = parent_id {
        let parent = fetch_work_item(db.inner(), pid).await?;
        if parent.parent_id.is_some() {
            return Err("Cannot nest sub-work-items more than one level deep".to_string());
        }
    }

    let worktree_path = if parent_id.is_none() {
        if let Some(repo_path) = repo_path.clone() {
            let info = create_worktree(
                id.clone(),
                repo_path,
                source_branch.clone(),
                branch_name.clone(),
            )
            .await?;
            branch_name = Some(info.branch_name.clone());
            source_branch = Some(info.source_branch.clone());
            Some(info.worktree_path)
        } else {
            None
        }
    } else {
        None
    };

    sqlx::query(
        r#"INSERT INTO work_items (
            id, title, context, execution_context, orchestrator_note, duplicate_of_work_item_id, duplicate_policy, intent_type, status, repo_path, source_branch, branch_name, worktree_path,
            assigned_agent, terminal_slot, parent_id, workspace_id, created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)"#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&context)
    .bind(&execution_context)
    .bind(&orchestrator_note)
    .bind(&duplicate_of_work_item_id)
    .bind(&duplicate_policy)
    .bind(&intent_type)
    .bind(&initial_status)
    .bind(&repo_path)
    .bind(&source_branch)
    .bind(&branch_name)
    .bind(&worktree_path)
    .bind(&assigned_agent)
    .bind(&parent_id)
    .bind(&workspace_id)
    .bind(&now)
    .bind(&now)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    fetch_work_item(db.inner(), &id).await
}

#[tauri::command]
pub async fn update_work_item(
    db: State<'_, SqlitePool>,
    id: String,
    fields: Value,
) -> Result<WorkItem, String> {
    let current = fetch_work_item(db.inner(), &id).await?;

    if current.status == "running" {
        return Err("Cannot update a work item that is currently running".to_string());
    }

    let allowed_fields = [
        "title",
        "context",
        "execution_context",
        "orchestrator_note",
        "duplicate_of_work_item_id",
        "duplicate_policy",
        "intent_type",
        "repo_path",
        "source_branch",
        "branch_name",
        "worktree_path",
        "assigned_agent",
        "terminal_slot",
        "parent_id",
    ];

    let obj = fields.as_object().ok_or("fields must be a JSON object")?;
    if obj.is_empty() {
        return Ok(current);
    }
    let should_ensure_worktree = obj.contains_key("repo_path")
        || obj.contains_key("source_branch")
        || obj.contains_key("branch_name")
        || obj.contains_key("worktree_path")
        || obj.contains_key("parent_id");

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
        "UPDATE work_items SET {} WHERE id = ?",
        set_clauses.join(", ")
    );
    sqlx::query_with(&sql, args)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    let updated = fetch_work_item(db.inner(), &id).await?;
    if (should_ensure_worktree || (updated.branch_name.is_none() || updated.worktree_path.is_none()))
        && updated.parent_id.is_none()
        && updated.repo_path.is_some()
    {
        let _ = ensure_top_level_worktree(db.inner(), &id).await?;
    }

    fetch_work_item(db.inner(), &id).await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimilarWorkItemCandidate {
    pub id: String,
    pub title: String,
    pub status: String,
    pub score: i64,
    pub repo_path: Option<String>,
    pub updated_at: String,
}

fn normalize_for_match(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn similarity_score(query: &str, work_item: &WorkItem) -> i64 {
    let query_norm = normalize_for_match(query);
    let title_norm = normalize_for_match(&work_item.title);
    if query_norm.is_empty() || title_norm.is_empty() {
        return 0;
    }

    if query_norm == title_norm {
        return 1000;
    }

    let mut score = 0_i64;
    if title_norm.contains(&query_norm) || query_norm.contains(&title_norm) {
        score += 700;
    }

    let query_tokens: std::collections::HashSet<_> = query_norm.split_whitespace().collect();
    let title_tokens: std::collections::HashSet<_> = title_norm.split_whitespace().collect();
    let overlap = query_tokens.intersection(&title_tokens).count() as i64;
    score += overlap * 100;

    if let Some(context) = work_item.execution_context.as_deref().or(work_item.context.as_deref()) {
        let context_norm = normalize_for_match(context);
        if context_norm.contains(&query_norm) {
            score += 150;
        }
    }

    if work_item.status == "done" {
        score += 20;
    }

    score
}

#[tauri::command]
pub async fn find_similar_work_items(
    db: State<'_, SqlitePool>,
    query: String,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SimilarWorkItemCandidate>, String> {
    let work_items = list_work_items(db, None, workspace_id).await?;
    let limit = limit.unwrap_or(5).clamp(1, 20) as usize;

    let mut matches = work_items
        .into_iter()
        .map(|work_item| SimilarWorkItemCandidate {
            score: similarity_score(&query, &work_item),
            id: work_item.id,
            title: work_item.title,
            status: work_item.status,
            repo_path: work_item.repo_path,
            updated_at: work_item.updated_at,
        })
        .filter(|candidate| candidate.score > 0)
        .collect::<Vec<_>>();

    matches.sort_by(|a, b| b.score.cmp(&a.score).then(b.updated_at.cmp(&a.updated_at)));
    matches.truncate(limit);
    Ok(matches)
}

#[tauri::command]
pub async fn reopen_work_item(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    id: String,
) -> Result<WorkItem, String> {
    let work_item = fetch_work_item(db.inner(), &id).await?;
    if !matches!(work_item.status.as_str(), "done" | "archived") {
        return Err(format!("Can only reopen done or archived work items, current state: {}", work_item.status));
    }

    let to_status = if work_item.repo_path.is_some() && work_item.assigned_agent.is_some() {
        "ready"
    } else {
        "draft"
    };
    let now = now_iso();
    sqlx::query(
        "UPDATE work_items SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(to_status)
    .bind(&now)
    .bind(&id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": id,
            "from": work_item.status,
            "to": to_status,
        }),
    )
    .map_err(|e| e.to_string())?;

    fetch_work_item(db.inner(), &id).await
}

#[tauri::command]
pub async fn list_work_items(
    db: State<'_, SqlitePool>,
    status_filter: Option<Vec<String>>,
    workspace_id: Option<String>,
) -> Result<Vec<WorkItem>, String> {
    let ws = workspace_id.unwrap_or_else(|| "default".to_string());

    let mut work_items = if let Some(statuses) = status_filter.filter(|s| !s.is_empty()) {
        let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "{} WHERE workspace_id = ? AND status IN ({}) ORDER BY updated_at DESC",
            SELECT_COLS, placeholders
        );
        let mut q = sqlx::query_as::<_, WorkItem>(&sql).bind(&ws);
        for s in &statuses {
            q = q.bind(s);
        }
        q.fetch_all(db.inner()).await.map_err(|e| e.to_string())?
    } else {
        let sql = format!("{} WHERE workspace_id = ? ORDER BY updated_at DESC", SELECT_COLS);
        sqlx::query_as::<_, WorkItem>(&sql)
            .bind(&ws)
            .fetch_all(db.inner())
            .await
            .map_err(|e| e.to_string())?
    };

    work_items.sort_by(|a, b| {
        let wa = status_weight(&a.status);
        let wb = status_weight(&b.status);
        wa.cmp(&wb).then(b.updated_at.cmp(&a.updated_at))
    });

    Ok(work_items)
}

#[tauri::command]
pub async fn get_work_item(db: State<'_, SqlitePool>, id: String) -> Result<WorkItem, String> {
    fetch_work_item(db.inner(), &id).await
}

#[tauri::command]
pub async fn transition_work_item(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    id: String,
    to_status: String,
) -> Result<WorkItem, String> {
    let work_item = fetch_work_item(db.inner(), &id).await?;
    let from_status = work_item.status.clone();

    if !is_valid_transition(&from_status, &to_status) {
        return Err(format!(
            "Invalid transition: {} → {}",
            from_status, to_status
        ));
    }

    match (from_status.as_str(), to_status.as_str()) {
        ("draft", "ready") => {
            if work_item.title.trim().is_empty() {
                return Err("Title is required to mark work item as ready".to_string());
            }
            if work_item
                .execution_context
                .as_deref()
                .or(work_item.context.as_deref())
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Execution context is required to mark work item as ready".to_string());
            }
            if work_item
                .repo_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Repo path is required to mark work item as ready".to_string());
            }
        }
        ("ready", "queued") => {
            if work_item
                .assigned_agent
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Assigned agent is required to queue a work item".to_string());
            }
            if work_item.terminal_slot.is_none() {
                return Err("Terminal slot is required to queue a work item".to_string());
            }
        }
        ("ready", "review") => {
            if work_item
                .repo_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
                || work_item
                    .worktree_path
                    .as_deref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
                || work_item
                    .branch_name
                    .as_deref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
            {
                return Err("Work item has no recoverable worktree to review".to_string());
            }
        }
        ("ready", "running") | ("review", "running") => {
            if work_item
                .assigned_agent
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Assigned agent is required to continue a work item".to_string());
            }
            if work_item.terminal_slot.is_none() {
                return Err("Terminal slot is required to continue a work item".to_string());
            }
            if work_item
                .worktree_path
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                return Err("Worktree path is required to continue a work item".to_string());
            }
        }
        _ => {}
    }

    let now = now_iso();

    if should_shutdown_session_for_transition(&from_status, &to_status) {
        let _ = shutdown_work_item_session(active_sessions.inner(), &id).await;
    }

    match (from_status.as_str(), to_status.as_str()) {
        ("queued", "running") | ("ready", "running") | ("review", "running") => {
            sqlx::query(
                "UPDATE work_items SET status = ?, started_at = ?, completed_at = NULL, updated_at = ? WHERE id = ?",
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
                "UPDATE work_items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
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
            sqlx::query("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
                .bind(&to_status)
                .bind(&now)
                .bind(&id)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;
        }
        ("review", "ready") => {
            sqlx::query(
                r#"UPDATE work_items SET
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
            sqlx::query("UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?")
                .bind(&to_status)
                .bind(&now)
                .bind(&id)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": id,
            "from": from_status,
            "to": to_status,
        }),
    )
    .map_err(|e| e.to_string())?;

    // When a work item is approved (done), cascade-unblock any blocked dependents
    if to_status == "done" {
        let _ = cascade_unblock_dependents(&app, db.inner(), &id).await;
    }

    fetch_work_item(db.inner(), &id).await
}

#[tauri::command]
pub async fn archive_work_item(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    id: String,
) -> Result<WorkItem, String> {
    let work_item = fetch_work_item(db.inner(), &id).await?;
    if work_item.status != "done" {
        return Err(format!(
            "Can only archive work items in 'done' state, current state: {}",
            work_item.status
        ));
    }
    transition_work_item(app, db, active_sessions, id, "archived".to_string()).await
}

#[tauri::command]
pub async fn close_work_item(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    id: String,
) -> Result<WorkItem, String> {
    let work_item = fetch_work_item(db.inner(), &id).await?;

    if work_item.status == "archived" {
        return Ok(work_item);
    }

    let _ = shutdown_work_item_session(active_sessions.inner(), &id).await;

    let now = now_iso();
    sqlx::query(
        "UPDATE work_items SET status = 'done', terminal_slot = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(&id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    if work_item.status != "done" {
        app.emit(
            "work-item:state-change",
            serde_json::json!({
                "workItemId": id,
                "from": work_item.status,
                "to": "done",
            }),
        )
        .map_err(|e| e.to_string())?;
    }

    fetch_work_item(db.inner(), &id).await
}

#[tauri::command]
pub async fn delete_work_item(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    id: String,
) -> Result<(), String> {
    let work_item = fetch_work_item(db.inner(), &id).await?;

    // Cascade-delete child work items first
    let children: Vec<WorkItem> = {
        let sql = format!("{} WHERE parent_id = ?", SELECT_COLS);
        sqlx::query_as::<_, WorkItem>(&sql)
            .bind(&id)
            .fetch_all(db.inner())
            .await
            .map_err(|e| e.to_string())?
    };
    for child in &children {
        let _ = shutdown_work_item_session(active_sessions.inner(), &child.id).await;
        if let (Some(rp), Some(wp), Some(bn)) = (
            child.repo_path.as_deref(),
            child.worktree_path.as_deref(),
            child.branch_name.as_deref(),
        ) {
            let _ = remove_worktree_internal(wp, rp, bn);
        }
        let _ = sqlx::query(
            "DELETE FROM agent_log_events WHERE log_id IN (SELECT id FROM agent_logs WHERE work_item_id = ?)"
        )
        .bind(&child.id)
        .execute(db.inner())
        .await;
        let _ = sqlx::query("DELETE FROM agent_logs WHERE work_item_id = ?").bind(&child.id).execute(db.inner()).await;
        let _ = sqlx::query("DELETE FROM work_item_attempts WHERE work_item_id = ?").bind(&child.id).execute(db.inner()).await;
        let _ = sqlx::query("DELETE FROM work_item_dependencies WHERE work_item_id = ? OR depends_on_id = ?").bind(&child.id).bind(&child.id).execute(db.inner()).await;
        let _ = sqlx::query("DELETE FROM work_items WHERE id = ?").bind(&child.id).execute(db.inner()).await;
        let _ = app.emit("work-item:state-change", serde_json::json!({ "workItemId": child.id, "from": child.status, "to": "deleted" }));
    }

    let _ = shutdown_work_item_session(active_sessions.inner(), &id).await;

    if let (Some(repo_path), Some(worktree_path), Some(branch_name)) = (
        work_item.repo_path.as_deref(),
        work_item.worktree_path.as_deref(),
        work_item.branch_name.as_deref(),
    ) {
        remove_worktree_internal(worktree_path, repo_path, branch_name)?;
    } else if let Some(worktree_path) = work_item.worktree_path.as_deref() {
        if PathBuf::from(worktree_path).exists() {
            std::fs::remove_dir_all(worktree_path)
                .map_err(|e| format!("Failed to remove worktree directory: {e}"))?;
        }
    }

    sqlx::query("DELETE FROM agent_log_events WHERE log_id IN (SELECT id FROM agent_logs WHERE work_item_id = ?)")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM agent_logs WHERE work_item_id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM work_item_attempts WHERE work_item_id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    // Remove all dependency edges involving this work item
    sqlx::query("DELETE FROM work_item_dependencies WHERE work_item_id = ? OR depends_on_id = ?")
        .bind(&id)
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM work_items WHERE id = ?")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": id,
            "from": work_item.status,
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

    let query_lc = query.to_lowercase();
    let mut matches: Vec<String> = load_repo_files(&root)
        .into_iter()
        .filter(|path| query_lc.is_empty() || path.to_lowercase().contains(&query_lc))
        .collect();

    matches.sort_by(|a, b| {
        let sa = score_path(a, &query);
        let sb = score_path(b, &query);
        sa.cmp(&sb).then(a.len().cmp(&b.len())).then(a.cmp(b))
    });
    matches.truncate(12);

    Ok(matches)
}

// ─── Sub-work-item helpers ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_child_work_items(
    db: State<'_, SqlitePool>,
    parent_id: String,
) -> Result<Vec<WorkItem>, String> {
    let sql = format!("{} WHERE parent_id = ? ORDER BY created_at ASC", SELECT_COLS);
    sqlx::query_as::<_, WorkItem>(&sql)
        .bind(&parent_id)
        .fetch_all(db.inner())
        .await
        .map_err(|e| e.to_string())
}

/// Returns true when the parent has at least one child and all children are done or archived.
pub async fn all_children_done(pool: &SqlitePool, parent_id: &str) -> Result<bool, String> {
    let (total,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM work_items WHERE parent_id = ?",
    )
    .bind(parent_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    if total == 0 {
        return Ok(false);
    }

    let (pending,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM work_items WHERE parent_id = ? AND status NOT IN ('done', 'archived')",
    )
    .bind(parent_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(pending == 0)
}

// ─── Attempt History ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItemAttempt {
    pub id: String,
    pub work_item_id: String,
    pub attempt_number: i64,
    pub agent_id: String,
    pub agent_log_id: Option<String>,
    pub outcome: String,
    pub rejection_reason: Option<String>,
    pub files_changed: Option<String>,
    pub diff_summary: Option<String>,
    pub duration_ms: Option<i64>,
    pub exit_code: Option<i64>,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for WorkItemAttempt {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(WorkItemAttempt {
            id: row.try_get("id")?,
            work_item_id: row.try_get("work_item_id")?,
            attempt_number: row.try_get("attempt_number")?,
            agent_id: row.try_get("agent_id")?,
            agent_log_id: row.try_get("agent_log_id")?,
            outcome: row.try_get("outcome")?,
            rejection_reason: row.try_get("rejection_reason")?,
            files_changed: row.try_get("files_changed")?,
            diff_summary: row.try_get("diff_summary")?,
            duration_ms: row.try_get("duration_ms")?,
            exit_code: row.try_get("exit_code")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

#[tauri::command]
pub async fn get_work_item_attempts(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<Vec<WorkItemAttempt>, String> {
    sqlx::query_as::<_, WorkItemAttempt>(
        "SELECT id, work_item_id, attempt_number, agent_id, agent_log_id, outcome, \
         rejection_reason, files_changed, diff_summary, duration_ms, exit_code, created_at \
         FROM work_item_attempts WHERE work_item_id = ? ORDER BY attempt_number ASC",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn record_work_item_attempt(
    db: State<'_, SqlitePool>,
    work_item_id: String,
    agent_id: String,
    agent_log_id: Option<String>,
    outcome: String,
    rejection_reason: Option<String>,
    files_changed: Option<String>,
    diff_summary: Option<String>,
    duration_ms: Option<i64>,
    exit_code: Option<i64>,
) -> Result<WorkItemAttempt, String> {
    let next_number: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM work_item_attempts WHERE work_item_id = ?",
    )
    .bind(&work_item_id)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    let id = Ulid::new().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO work_item_attempts \
         (id, work_item_id, attempt_number, agent_id, agent_log_id, outcome, \
          rejection_reason, files_changed, diff_summary, duration_ms, exit_code, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&work_item_id)
    .bind(next_number.0)
    .bind(&agent_id)
    .bind(&agent_log_id)
    .bind(&outcome)
    .bind(&rejection_reason)
    .bind(&files_changed)
    .bind(&diff_summary)
    .bind(duration_ms)
    .bind(exit_code)
    .bind(&now)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(WorkItemAttempt {
        id,
        work_item_id,
        attempt_number: next_number.0,
        agent_id,
        agent_log_id,
        outcome,
        rejection_reason,
        files_changed,
        diff_summary,
        duration_ms,
        exit_code,
        created_at: now,
    })
}

// ─── Dependency types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItemDependency {
    pub work_item_id: String,
    pub depends_on_id: String,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for WorkItemDependency {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(WorkItemDependency {
            work_item_id: row.try_get("work_item_id")?,
            depends_on_id: row.try_get("depends_on_id")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

// ─── Dependency Commands ──────────────────────────────────────────────────────

/// Check if adding a dependency would create a cycle (DFS from depends_on_id).
async fn would_create_cycle(pool: &SqlitePool, work_item_id: &str, depends_on_id: &str) -> Result<bool, String> {
    // DFS: starting from depends_on_id, follow its own dependencies.
    // If we reach work_item_id, it's a cycle.
    let mut stack = vec![depends_on_id.to_string()];
    let mut visited = std::collections::HashSet::new();

    while let Some(current) = stack.pop() {
        if current == work_item_id {
            return Ok(true);
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        let deps: Vec<(String,)> = sqlx::query_as(
            "SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id = ?",
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
pub async fn add_work_item_dependency(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    work_item_id: String,
    depends_on_id: String,
) -> Result<(), String> {
    if work_item_id == depends_on_id {
        return Err("A work item cannot depend on itself".to_string());
    }

    // Verify both work items exist
    let _ = fetch_work_item(db.inner(), &work_item_id).await?;
    let _ = fetch_work_item(db.inner(), &depends_on_id).await?;

    // Check for cycles
    if would_create_cycle(db.inner(), &work_item_id, &depends_on_id).await? {
        return Err("Adding this dependency would create a circular dependency".to_string());
    }

    sqlx::query(
        "INSERT OR IGNORE INTO work_item_dependencies (work_item_id, depends_on_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(&work_item_id)
    .bind(&depends_on_id)
    .bind(now_iso())
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:deps-changed",
        serde_json::json!({ "workItemId": work_item_id }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn remove_work_item_dependency(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    work_item_id: String,
    depends_on_id: String,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM work_item_dependencies WHERE work_item_id = ? AND depends_on_id = ?",
    )
    .bind(&work_item_id)
    .bind(&depends_on_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:deps-changed",
        serde_json::json!({ "workItemId": work_item_id }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get work items that this work item depends on (upstream dependencies).
#[tauri::command]
pub async fn get_work_item_dependencies(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<Vec<WorkItemDependency>, String> {
    sqlx::query_as::<_, WorkItemDependency>(
        "SELECT work_item_id, depends_on_id, created_at FROM work_item_dependencies WHERE work_item_id = ? ORDER BY created_at",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Get work items that depend on this work item (downstream dependents).
#[tauri::command]
pub async fn get_work_item_dependents(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<Vec<WorkItemDependency>, String> {
    sqlx::query_as::<_, WorkItemDependency>(
        "SELECT work_item_id, depends_on_id, created_at FROM work_item_dependencies WHERE depends_on_id = ? ORDER BY created_at",
    )
    .bind(&work_item_id)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Check if a work item has unmet dependencies (any dependency not in done/archived).
#[tauri::command]
pub async fn has_unmet_dependencies(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<bool, String> {
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM work_item_dependencies td \
         JOIN work_items t ON t.id = td.depends_on_id \
         WHERE td.work_item_id = ? AND t.status NOT IN ('done', 'archived')",
    )
    .bind(&work_item_id)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(count.0 > 0)
}

/// After a work item is approved (done), find blocked dependents that are now unblocked
/// and transition them to ready. Returns the list of unblocked work item IDs.
pub async fn cascade_unblock_dependents(
    app: &AppHandle,
    pool: &SqlitePool,
    approved_work_item_id: &str,
) -> Result<Vec<String>, String> {
    // Find all blocked work items that depend on the approved work item
    let blocked_dependents: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT td.work_item_id FROM work_item_dependencies td \
         JOIN work_items t ON t.id = td.work_item_id \
         WHERE td.depends_on_id = ? AND t.status = 'blocked'",
    )
    .bind(approved_work_item_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let now = now_iso();
    let mut unblocked = Vec::new();

    for (dep_work_item_id,) in blocked_dependents {
        // Check if ALL dependencies of this work item are now done/archived
        let unmet: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM work_item_dependencies td \
             JOIN work_items t ON t.id = td.depends_on_id \
             WHERE td.work_item_id = ? AND t.status NOT IN ('done', 'archived')",
        )
        .bind(&dep_work_item_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

        if unmet.0 == 0 {
            // All deps met — unblock to ready
            sqlx::query("UPDATE work_items SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'blocked'")
                .bind(&now)
                .bind(&dep_work_item_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit(
                "work-item:state-change",
                serde_json::json!({
                    "workItemId": dep_work_item_id,
                    "from": "blocked",
                    "to": "ready",
                }),
            );

            unblocked.push(dep_work_item_id);
        }
    }

    if !unblocked.is_empty() {
        let _ = app.emit(
            "work-item:deps-unblocked",
            serde_json::json!({ "workItemIds": unblocked }),
        );
    }

    Ok(unblocked)
}
