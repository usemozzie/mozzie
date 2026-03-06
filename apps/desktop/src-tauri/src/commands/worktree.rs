use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::path::PathBuf;
use std::process::Output;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeInfo {
    pub worktree_path: String,
    pub branch_name: String,
    pub source_branch: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepoBranchInfo {
    pub branch_name: String,
    pub detached: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TicketReviewState {
    pub ticket_id: String,
    pub review_status: String,
    pub summary: String,
    pub source_branch: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub diff: String,
    pub has_changes: bool,
    pub is_merged: bool,
    pub worktree_present: bool,
    pub branch_present: bool,
    pub can_review: bool,
    pub can_continue: bool,
}

#[derive(Debug, Clone)]
struct TicketGitInfo {
    id: String,
    status: String,
    repo_path: Option<String>,
    source_branch: Option<String>,
    branch_name: Option<String>,
    worktree_path: Option<String>,
}

fn worktrees_base() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".mozzie").join("worktrees")
}

fn integration_worktree_path(repo_path: &str, source_branch: &str) -> PathBuf {
    let repo_slug = PathBuf::from(repo_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let branch_slug = source_branch
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();

    worktrees_base()
        .join("_integration")
        .join(format!("{repo_slug}-{branch_slug}"))
}

fn run_git_output(args: &[&str]) -> Result<Output, String> {
    std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))
}

fn run_git(args: &[&str]) -> Result<String, String> {
    let out = run_git_output(args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git error: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn run_git_with_configs(cwd: &str, configs: &[&str], args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(cwd);

    for config in configs {
        command.arg("-c").arg(config);
    }

    let out = command
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn run_git_in_repo(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C", repo_path];
    full_args.extend_from_slice(args);
    run_git(&full_args)
}

fn run_git_in_repo_output(repo_path: &str, args: &[&str]) -> Result<Output, String> {
    let mut full_args = vec!["-C", repo_path];
    full_args.extend_from_slice(args);
    run_git_output(&full_args)
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn has_valid_worktree(worktree_path: &str) -> bool {
    let path = PathBuf::from(worktree_path);
    path.exists() && run_git(&["-C", worktree_path, "rev-parse", "--git-dir"]).is_ok()
}

fn branch_exists(repo_path: &str, branch_name: &str) -> bool {
    run_git_in_repo_output(repo_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch_name}")])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn source_branch_exists(repo_path: &str, source_branch: &str) -> bool {
    branch_exists(repo_path, source_branch)
}

fn is_branch_merged(repo_path: &str, branch_name: &str, source_branch: &str) -> Result<bool, String> {
    let out = run_git_in_repo_output(repo_path, &["merge-base", "--is-ancestor", branch_name, source_branch])?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(format!("git error: {stderr}"))
        }
    }
}

fn remove_worktree_internal(worktree_path: &str, repo_path: &str, branch_name: &str) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    if PathBuf::from(worktree_path).exists() {
        if let Err(err) = run_git_in_repo(repo_path, &["worktree", "remove", "--force", worktree_path]) {
            errors.push(format!("Failed to remove worktree: {err}"));
        }
    }

    if branch_exists(repo_path, branch_name) {
        if let Err(err) = run_git_in_repo(repo_path, &["branch", "-D", branch_name]) {
            errors.push(format!("Failed to delete branch: {err}"));
        }
    }

    if let Err(err) = run_git_in_repo(repo_path, &["worktree", "prune"]) {
        errors.push(format!("Failed to prune worktrees: {err}"));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" | "))
    }
}

fn remove_integration_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    if PathBuf::from(worktree_path).exists() {
        if let Err(err) = run_git_in_repo(repo_path, &["worktree", "remove", "--force", worktree_path]) {
            errors.push(format!("Failed to remove integration worktree: {err}"));
        }
    }

    if let Err(err) = run_git_in_repo(repo_path, &["worktree", "prune"]) {
        errors.push(format!("Failed to prune worktrees: {err}"));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" | "))
    }
}

fn get_diff_internal(worktree_path: &str, source_branch: Option<&str>) -> Result<String, String> {
    let base = match source_branch {
        Some(s) if !s.trim().is_empty() => s,
        _ => "HEAD",
    };

    let mut diff = run_git(&["-C", worktree_path, "diff", "--no-ext-diff", "--find-renames", base])?;
    let untracked = run_git(&[
        "-C",
        worktree_path,
        "ls-files",
        "--others",
        "--exclude-standard",
    ])?;

    if !untracked.is_empty() {
        if !diff.is_empty() {
            diff.push_str("\n\n");
        }
        diff.push_str("Untracked files pending commit:\n");
        for path in untracked.lines() {
            diff.push_str("  + ");
            diff.push_str(path);
            diff.push('\n');
        }
    }

    Ok(diff)
}

fn commit_pending_changes(worktree_path: &str, branch_name: &str) -> Result<bool, String> {
    let status = run_git(&["-C", worktree_path, "status", "--porcelain"])?;
    if status.is_empty() {
        return Ok(false);
    }

    run_git(&["-C", worktree_path, "add", "-A"])?;
    run_git_with_configs(
        worktree_path,
        &["user.name=Mozzie", "user.email=mozzie@local"],
        &["commit", "--no-verify", "-m", &format!("Mozzie: checkpoint {branch_name}")],
    )?;
    Ok(true)
}

fn merge_branch_internal(
    repo_path: &str,
    worktree_path: &str,
    source_branch: &str,
    branch_name: &str,
) -> Result<(), String> {
    if is_branch_merged(repo_path, branch_name, source_branch)? {
        return Ok(());
    }

    let _ = commit_pending_changes(worktree_path, branch_name)?;
    let integration_path = integration_worktree_path(repo_path, source_branch);
    let integration_path_str = integration_path.to_string_lossy().to_string();

    if let Some(parent) = integration_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create integration worktree directory: {err}"))?;
    }

    if has_valid_worktree(&integration_path_str) {
        run_git_in_repo(repo_path, &["worktree", "remove", "--force", &integration_path_str])?;
    } else if integration_path.exists() {
        std::fs::remove_dir_all(&integration_path)
            .map_err(|err| format!("Cannot clean stale integration worktree directory: {err}"))?;
    }

    run_git_in_repo(
        repo_path,
        &["worktree", "add", "--force", &integration_path_str, source_branch],
    )?;

    let merge_result = run_git(
        &["-C", &integration_path_str, "merge", "--no-ff", "--no-edit", branch_name],
    );
    let cleanup_result = remove_integration_worktree(repo_path, &integration_path_str);

    match (merge_result, cleanup_result) {
        (Ok(_), Ok(())) => Ok(()),
        (Err(merge_err), Ok(())) => Err(merge_err),
        (Ok(_), Err(cleanup_err)) => Err(cleanup_err),
        (Err(merge_err), Err(cleanup_err)) => Err(format!("{merge_err} | {cleanup_err}")),
    }?;

    Ok(())
}

async fn fetch_ticket_git_info(pool: &SqlitePool, ticket_id: &str) -> Result<TicketGitInfo, String> {
    sqlx::query(
        "SELECT id, status, repo_path, source_branch, branch_name, worktree_path FROM tickets WHERE id = ?",
    )
    .bind(ticket_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .map(|row| TicketGitInfo {
        id: row.try_get("id").unwrap_or_default(),
        status: row.try_get("status").unwrap_or_default(),
        repo_path: row.try_get("repo_path").ok().flatten(),
        source_branch: row.try_get("source_branch").ok().flatten(),
        branch_name: row.try_get("branch_name").ok().flatten(),
        worktree_path: row.try_get("worktree_path").ok().flatten(),
    })
    .ok_or_else(|| format!("Ticket {ticket_id} not found"))
}

fn compute_review_state(ticket: &TicketGitInfo) -> TicketReviewState {
    let repo_path = ticket.repo_path.as_deref();
    let source_branch = ticket.source_branch.as_deref();
    let branch_name = ticket.branch_name.as_deref();
    let worktree_path = ticket.worktree_path.as_deref();

    let worktree_present = worktree_path.map(has_valid_worktree).unwrap_or(false);
    let branch_present = match (repo_path, branch_name) {
        (Some(repo_path), Some(branch_name)) => branch_exists(repo_path, branch_name),
        _ => false,
    };
    let source_branch_present = match (repo_path, source_branch) {
        (Some(repo_path), Some(source_branch)) => source_branch_exists(repo_path, source_branch),
        _ => false,
    };

    let diff = if worktree_present {
        get_diff_internal(worktree_path.unwrap(), source_branch).unwrap_or_default()
    } else {
        String::new()
    };
    let has_changes = !diff.trim().is_empty();

    let is_merged = match (repo_path, branch_name, source_branch) {
        (Some(repo_path), Some(branch_name), Some(source_branch)) if branch_present && source_branch_present => {
            is_branch_merged(repo_path, branch_name, source_branch).unwrap_or(false)
        }
        _ => false,
    };

    let (review_status, summary) = if repo_path.is_none() {
        ("unavailable", "Set a repository on the ticket to enable Git review.")
    } else if worktree_path.is_none() || !worktree_present {
        ("unavailable", "No active ticket worktree is available.")
    } else if branch_name.is_none() || !branch_present {
        ("unavailable", "The ticket branch is missing.")
    } else if source_branch.is_none() || !source_branch_present {
        ("unavailable", "The source branch is missing.")
    } else if is_merged && !has_changes {
        ("merged", "This ticket branch is already merged into the source branch.")
    } else if has_changes {
        ("changes", "Git changes are ready for review.")
    } else {
        ("clean", "No Git changes are pending review.")
    };

    let legacy_review = ticket.status == "review";
    let has_git_context = ticket.repo_path.is_some()
        || ticket.source_branch.is_some()
        || ticket.branch_name.is_some()
        || ticket.worktree_path.is_some();
    let is_closed = matches!(ticket.status.as_str(), "done" | "archived");
    let can_review = has_git_context || legacy_review || !matches!(review_status, "unavailable");
    let can_continue = !is_closed && worktree_present && branch_present && !is_merged;

    TicketReviewState {
        ticket_id: ticket.id.clone(),
        review_status: review_status.to_string(),
        summary: summary.to_string(),
        source_branch: ticket.source_branch.clone(),
        branch_name: ticket.branch_name.clone(),
        worktree_path: ticket.worktree_path.clone(),
        diff,
        has_changes,
        is_merged,
        worktree_present,
        branch_present,
        can_review,
        can_continue,
    }
}

/// Validate a git branch name (simplified check matching git-check-ref-format rules).
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') || name.starts_with('.') {
        return Err("Branch name cannot start with '-' or '.'".to_string());
    }
    if name.ends_with('/') || name.ends_with('.') || name.ends_with(".lock") {
        return Err("Branch name cannot end with '/', '.' or '.lock'".to_string());
    }
    if name.contains("..") || name.contains("~") || name.contains("^") || name.contains(":")
        || name.contains("\\") || name.contains(" ") || name.contains("?") || name.contains("*")
        || name.contains("[") || name.contains("@{")
    {
        return Err("Branch name contains invalid characters".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn create_worktree(
    ticket_id: String,
    repo_path: String,
    source_branch: Option<String>,
    branch_name: Option<String>,
) -> Result<WorktreeInfo, String> {
    let branch_name = match branch_name {
        Some(b) if !b.trim().is_empty() => {
            let name = b.trim().to_string();
            validate_branch_name(&name)?;
            name
        }
        _ => format!("mozzie/{}", ticket_id),
    };
    let base = worktrees_base();
    let worktree_path = base.join(&ticket_id);
    let worktree_str = worktree_path.to_string_lossy().to_string();
    let source = match source_branch {
        Some(b) if !b.trim().is_empty() => b,
        _ => run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"] )?,
    };

    if worktree_path.exists() && has_valid_worktree(&worktree_str) {
        return Ok(WorktreeInfo {
            worktree_path: worktree_str,
            branch_name,
            source_branch: source,
        });
    }

    let _ = run_git(&["-C", &repo_path, "worktree", "remove", "--force", &worktree_str]);
    let _ = run_git(&["-C", &repo_path, "branch", "-D", &branch_name]);
    let _ = run_git(&["-C", &repo_path, "worktree", "prune"]);
    let _ = std::fs::remove_dir_all(&worktree_path);

    std::fs::create_dir_all(&base)
        .map_err(|e| format!("Cannot create worktrees directory: {e}"))?;

    run_git(&[
        "-C", &repo_path,
        "worktree", "add",
        "-b", &branch_name,
        &worktree_str,
        &source,
    ])?;

    Ok(WorktreeInfo {
        worktree_path: worktree_str,
        branch_name,
        source_branch: source,
    })
}

#[tauri::command]
pub async fn remove_worktree(
    worktree_path: String,
    repo_path: String,
    branch_name: String,
) -> Result<(), String> {
    remove_worktree_internal(&worktree_path, &repo_path, &branch_name)
}

#[tauri::command]
pub async fn get_diff(
    worktree_path: String,
    source_branch: Option<String>,
) -> Result<String, String> {
    get_diff_internal(&worktree_path, source_branch.as_deref())
}

#[tauri::command]
pub async fn merge_branch(
    repo_path: String,
    worktree_path: String,
    source_branch: String,
    branch_name: String,
) -> Result<(), String> {
    merge_branch_internal(&repo_path, &worktree_path, &source_branch, &branch_name)
}

#[tauri::command]
pub async fn get_ticket_review_state(
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<TicketReviewState, String> {
    let ticket = fetch_ticket_git_info(db.inner(), &ticket_id).await?;
    Ok(compute_review_state(&ticket))
}

#[tauri::command]
pub async fn approve_ticket_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<(), String> {
    let ticket = fetch_ticket_git_info(db.inner(), &ticket_id).await?;
    let from_status = ticket.status.clone();
    let repo_path = ticket.repo_path.as_deref().ok_or("Ticket has no repo_path")?;
    let worktree_path = ticket.worktree_path.as_deref().ok_or("Ticket has no worktree_path")?;
    let source_branch = ticket.source_branch.as_deref().ok_or("Ticket has no source_branch")?;
    let branch_name = ticket.branch_name.as_deref().ok_or("Ticket has no branch_name")?;

    if !source_branch_exists(repo_path, source_branch) {
        return Err(format!(
            "Source branch '{source_branch}' is missing. Refusing to approve because merge cannot be verified."
        ));
    }

    if !branch_exists(repo_path, branch_name) {
        return Err(format!(
            "Ticket branch '{branch_name}' is missing. Refusing to approve because merge cannot be verified."
        ));
    }

    let already_merged = is_branch_merged(repo_path, branch_name, source_branch)?;

    if !already_merged {
        if !has_valid_worktree(worktree_path) {
            return Err(
                "Ticket worktree is missing. Cannot checkpoint pending work before merge; approval aborted."
                    .to_string(),
            );
        }

        merge_branch_internal(repo_path, worktree_path, source_branch, branch_name)?;

        if !is_branch_merged(repo_path, branch_name, source_branch)? {
            return Err(format!(
                "Merge verification failed: branch '{branch_name}' is not an ancestor of '{source_branch}'."
            ));
        }
    }

    remove_worktree_internal(worktree_path, repo_path, branch_name)?;

    let now = now_iso();
    sqlx::query(
        r#"UPDATE tickets SET
            status = 'done', terminal_slot = NULL,
            worktree_path = NULL, source_branch = NULL, branch_name = NULL,
            completed_at = ?, updated_at = ?
          WHERE id = ?"#,
    )
    .bind(&now)
    .bind(&now)
    .bind(&ticket_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": ticket_id,
            "from": from_status,
            "to": "done",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn reject_ticket_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<(), String> {
    let ticket = fetch_ticket_git_info(db.inner(), &ticket_id).await?;
    let from_status = ticket.status.clone();

    if let (Some(repo_path), Some(worktree_path), Some(branch_name)) = (
        ticket.repo_path.as_deref(),
        ticket.worktree_path.as_deref(),
        ticket.branch_name.as_deref(),
    ) {
        remove_worktree_internal(worktree_path, repo_path, branch_name)?;
    }

    let now = now_iso();
    sqlx::query(
        r#"UPDATE tickets SET
            status = 'ready', terminal_slot = NULL,
            started_at = NULL, completed_at = NULL,
            worktree_path = NULL, source_branch = NULL, branch_name = NULL,
            updated_at = ?
          WHERE id = ?"#,
    )
    .bind(&now)
    .bind(&ticket_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": ticket_id,
            "from": from_status,
            "to": "ready",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_ticket_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    ticket_id: String,
) -> Result<(), String> {
    let ticket = fetch_ticket_git_info(db.inner(), &ticket_id).await?;
    let from_status = ticket.status.clone();
    let now = now_iso();

    sqlx::query(
        r#"UPDATE tickets SET
            status = 'done', terminal_slot = NULL,
            completed_at = ?, updated_at = ?
          WHERE id = ?"#,
    )
    .bind(&now)
    .bind(&now)
    .bind(&ticket_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "ticket:state-change",
        serde_json::json!({
            "ticketId": ticket_id,
            "from": from_status,
            "to": "done",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_repo_branch(repo_path: String) -> Result<RepoBranchInfo, String> {
    let branch_name = run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"])?;
    let detached = branch_name == "HEAD";

    Ok(RepoBranchInfo {
        branch_name,
        detached,
    })
}

#[tauri::command]
pub async fn list_repo_branches(repo_path: String) -> Result<Vec<String>, String> {
    let current = run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default();

    let output = run_git(&[
        "-C", &repo_path,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads/",
    ])?;

    let mut branches: Vec<String> = output
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect();

    if !current.is_empty() && current != "HEAD" {
        if let Some(pos) = branches.iter().position(|b| b == &current) {
            branches.remove(pos);
        }
        branches.insert(0, current);
    }

    Ok(branches)
}
