use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::path::{Path, PathBuf};
use std::process::Output;
use tauri::{AppHandle, Emitter, State};

use crate::commands::agents::{shutdown_work_item_session, ActiveSessions};
use crate::commands::work_items::all_children_done;

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
pub struct WorkItemReviewState {
    pub work_item_id: String,
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
    pub remote_branch_name: Option<String>,
    pub remote_branch_exists: bool,
    pub ahead_count: i64,
    pub behind_count: i64,
    pub needs_push: bool,
    pub can_push: bool,
    pub push_summary: String,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkItemGitInfo {
    id: String,
    status: String,
    repo_path: Option<String>,
    source_branch: Option<String>,
    branch_name: Option<String>,
    worktree_path: Option<String>,
    parent_id: Option<String>,
    workspace_id: String,
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

fn repo_has_commits(repo_path: &str) -> bool {
    run_git_in_repo_output(repo_path, &["rev-parse", "--verify", "HEAD"])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn current_branch_name(repo_path: &str) -> Result<RepoBranchInfo, String> {
    if repo_has_commits(repo_path) {
        let branch_name = run_git(&["-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"])?;
        return Ok(RepoBranchInfo {
            detached: branch_name == "HEAD",
            branch_name,
        });
    }

    let branch_name = run_git(&["-C", repo_path, "symbolic-ref", "--short", "HEAD"])?;
    Ok(RepoBranchInfo {
        branch_name,
        detached: false,
    })
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

fn remote_branch_exists(repo_path: &str, branch_name: &str) -> bool {
    run_git_in_repo_output(
        repo_path,
        &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{branch_name}")],
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
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

fn ahead_behind_counts(repo_path: &str, branch_name: &str) -> Result<(i64, i64), String> {
    let out = run_git(
        &[
            "-C",
            repo_path,
            "rev-list",
            "--left-right",
            "--count",
            &format!("origin/{branch_name}...{branch_name}"),
        ],
    )?;
    let mut counts = out.split_whitespace();
    let behind = counts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let ahead = counts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

pub(crate) fn remove_worktree_internal(worktree_path: &str, repo_path: &str, branch_name: &str) -> Result<(), String> {
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
        let mut rendered_untracked = Vec::new();

        for path in untracked.lines().filter(|line| !line.trim().is_empty()) {
            rendered_untracked.push(render_untracked_file_diff(worktree_path, path)?);
        }

        diff.push_str(&rendered_untracked.join("\n\n"));
    }

    Ok(diff)
}

fn render_untracked_file_diff(worktree_path: &str, relative_path: &str) -> Result<String, String> {
    let file_path = Path::new(worktree_path).join(relative_path);
    let output = std::process::Command::new("git")
        .current_dir(worktree_path)
        .args(["diff", "--no-index", "--no-ext-diff", "--find-renames", "--", "/dev/null"])
        .arg(&file_path)
        .output()
        .map_err(|err| format!("Failed to render diff for untracked file {relative_path}: {err}"))?;

    match output.status.code() {
        Some(0) | Some(1) => {}
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!(
                "git error while rendering diff for untracked file {relative_path}: {stderr}"
            ));
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(normalize_no_index_diff_paths(&stdout, relative_path))
}

fn normalize_no_index_diff_paths(diff: &str, relative_path: &str) -> String {
    let normalized = relative_path.replace('\\', "/");
    let full_new_path = format!("b/{normalized}");

    diff.lines()
        .map(|line| {
            if line.starts_with("diff --git ") {
                format!("diff --git a/{normalized} {full_new_path}")
            } else if line.starts_with("--- ") {
                format!("--- /dev/null")
            } else if line.starts_with("+++ ") {
                format!("+++ {full_new_path}")
            } else if line.starts_with("Binary files ") {
                format!("Binary files /dev/null and {full_new_path} differ")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn commit_pending_changes(worktree_path: &str, branch_name: &str, git_configs: &[String]) -> Result<bool, String> {
    let status = run_git(&["-C", worktree_path, "status", "--porcelain"])?;
    if status.is_empty() {
        return Ok(false);
    }

    run_git(&["-C", worktree_path, "add", "-A"])?;
    let config_refs: Vec<&str> = git_configs.iter().map(|s| s.as_str()).collect();
    run_git_with_configs(
        worktree_path,
        &config_refs,
        &["commit", "--no-verify", "-m", &format!("Mozzie: checkpoint {branch_name}")],
    )?;
    Ok(true)
}

fn sync_worktree_to_branch(worktree_path: &str, branch_name: &str) -> Result<(), String> {
    if !has_valid_worktree(worktree_path) {
        return Ok(());
    }

    run_git(&["-C", worktree_path, "reset", "--hard", branch_name])?;
    run_git(&["-C", worktree_path, "clean", "-fd"])?;
    Ok(())
}

fn merge_branch_internal(
    repo_path: &str,
    worktree_path: &str,
    source_branch: &str,
    branch_name: &str,
    git_configs: &[String],
) -> Result<(), String> {
    // Commit pending changes BEFORE checking merge status — otherwise
    // uncommitted work causes is_branch_merged to return a false positive.
    let _ = commit_pending_changes(worktree_path, branch_name, git_configs);

    if is_branch_merged(repo_path, branch_name, source_branch)? {
        return Ok(());
    }
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

async fn fetch_work_item_git_info(pool: &SqlitePool, work_item_id: &str) -> Result<WorkItemGitInfo, String> {
    sqlx::query(
        "SELECT id, status, repo_path, source_branch, branch_name, worktree_path, parent_id, workspace_id FROM work_items WHERE id = ?",
    )
    .bind(work_item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .map(|row| WorkItemGitInfo {
        id: row.try_get("id").unwrap_or_default(),
        status: row.try_get("status").unwrap_or_default(),
        repo_path: row.try_get("repo_path").ok().flatten(),
        source_branch: row.try_get("source_branch").ok().flatten(),
        branch_name: row.try_get("branch_name").ok().flatten(),
        worktree_path: row.try_get("worktree_path").ok().flatten(),
        parent_id: row.try_get("parent_id").ok().flatten(),
        workspace_id: row.try_get::<String, _>("workspace_id").unwrap_or_else(|_| "default".to_string()),
    })
    .ok_or_else(|| format!("Work item {work_item_id} not found"))
}

fn compute_review_state(work_item: &WorkItemGitInfo) -> WorkItemReviewState {
    let repo_path = work_item.repo_path.as_deref();
    let source_branch = work_item.source_branch.as_deref();
    let branch_name = work_item.branch_name.as_deref();
    let worktree_path = work_item.worktree_path.as_deref();

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
    let remote_branch_name = branch_name.map(|name| format!("origin/{name}"));
    let remote_branch_exists = match (repo_path, branch_name) {
        (Some(repo_path), Some(branch_name)) if branch_present => remote_branch_exists(repo_path, branch_name),
        _ => false,
    };
    let (ahead_count, behind_count) = match (repo_path, branch_name) {
        (Some(repo_path), Some(branch_name)) if branch_present && remote_branch_exists => {
            ahead_behind_counts(repo_path, branch_name).unwrap_or((0, 0))
        }
        _ => (0, 0),
    };
    // Check for uncommitted changes in the worktree — these will become a
    // commit before push, so the branch effectively "needs push" even when
    // ahead_count is currently 0.
    let has_uncommitted = worktree_present && worktree_path
        .map(|path| {
            run_git(&["-C", path, "status", "--porcelain"])
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let needs_push = branch_present && (!remote_branch_exists || ahead_count > 0 || has_uncommitted);
    let can_push = branch_present && (!remote_branch_exists || behind_count == 0);
    let push_summary = if !branch_present {
        "The work item branch is missing.".to_string()
    } else if !remote_branch_exists {
        "This branch has not been pushed to GitHub yet.".to_string()
    } else if has_uncommitted {
        format!(
            "Uncommitted changes will be committed and pushed{}.",
            if ahead_count > 0 {
                format!(" (plus {ahead_count} existing commit(s))")
            } else {
                String::new()
            }
        )
    } else if ahead_count > 0 && behind_count > 0 {
        format!(
            "This branch has diverged from origin (ahead {ahead_count}, behind {behind_count})."
        )
    } else if ahead_count > 0 {
        format!("This branch is ahead of origin by {ahead_count} commit(s).")
    } else if behind_count > 0 {
        format!("This branch is behind origin by {behind_count} commit(s).")
    } else {
        "This branch is up to date with origin.".to_string()
    };

    let (review_status, summary) = if repo_path.is_none() {
        ("unavailable", "Set a repository on the work item to enable Git review.")
    } else if worktree_path.is_none() || !worktree_present {
        ("unavailable", "No active work item worktree is available.")
    } else if branch_name.is_none() || !branch_present {
        ("unavailable", "The work item branch is missing.")
    } else if source_branch.is_none() || !source_branch_present {
        ("unavailable", "The source branch is missing.")
    } else if is_merged && !has_changes {
        ("merged", "This work item branch is already merged into the source branch.")
    } else if has_changes {
        ("changes", "Git changes are ready for review.")
    } else {
        ("clean", "No Git changes are pending review.")
    };

    let legacy_review = work_item.status == "review";
    let has_git_context = work_item.repo_path.is_some()
        || work_item.source_branch.is_some()
        || work_item.branch_name.is_some()
        || work_item.worktree_path.is_some();
    let is_closed = matches!(work_item.status.as_str(), "done" | "archived");
    let can_review = has_git_context || legacy_review || !matches!(review_status, "unavailable");
    let can_continue = !is_closed && worktree_present && branch_present && !is_merged;

    WorkItemReviewState {
        work_item_id: work_item.id.clone(),
        review_status: review_status.to_string(),
        summary: summary.to_string(),
        source_branch: work_item.source_branch.clone(),
        branch_name: work_item.branch_name.clone(),
        worktree_path: work_item.worktree_path.clone(),
        diff,
        has_changes,
        is_merged,
        worktree_present,
        branch_present,
        can_review,
        can_continue,
        remote_branch_name,
        remote_branch_exists,
        ahead_count,
        behind_count,
        needs_push,
        can_push,
        push_summary,
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
    work_item_id: String,
    repo_path: String,
    source_branch: Option<String>,
    branch_name: Option<String>,
) -> Result<WorktreeInfo, String> {
    if !repo_has_commits(&repo_path) {
        return Err(
            "Repository has no commits yet. Create an initial commit in that repo, then run the work item again."
                .to_string(),
        );
    }

    let branch_name = match branch_name {
        Some(b) if !b.trim().is_empty() => {
            let name = b.trim().to_string();
            validate_branch_name(&name)?;
            name
        }
        _ => format!("mozzie/{}", work_item_id),
    };
    let base = worktrees_base();
    let worktree_path = base.join(&work_item_id);
    let worktree_str = worktree_path.to_string_lossy().to_string();
    let source = match source_branch {
        Some(b) if !b.trim().is_empty() => b,
        _ => run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"] )?,
    };

    if worktree_path.exists() && has_valid_worktree(&worktree_str) {
        let current = current_branch_name(&worktree_str)?;
        if current.branch_name == branch_name {
            return Ok(WorktreeInfo {
                worktree_path: worktree_str,
                branch_name,
                source_branch: source,
            });
        }
    }

    let _ = run_git(&["-C", &repo_path, "worktree", "remove", "--force", &worktree_str]);
    let _ = run_git(&["-C", &repo_path, "worktree", "prune"]);
    let _ = std::fs::remove_dir_all(&worktree_path);

    std::fs::create_dir_all(&base)
        .map_err(|e| format!("Cannot create worktrees directory: {e}"))?;

    if branch_exists(&repo_path, &branch_name) {
        run_git(&[
            "-C",
            &repo_path,
            "worktree",
            "add",
            "--force",
            &worktree_str,
            &branch_name,
        ])?;
    } else {
        run_git(&[
            "-C",
            &repo_path,
            "worktree",
            "add",
            "--force",
            "-b",
            &branch_name,
            &worktree_str,
            &source,
        ])?;
    }

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
    db: State<'_, SqlitePool>,
    repo_path: String,
    worktree_path: String,
    source_branch: String,
    branch_name: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let ws = workspace_id.unwrap_or_else(|| "default".to_string());
    let git_configs = crate::commands::workspaces::get_workspace_git_configs(db.inner(), &ws).await;
    merge_branch_internal(&repo_path, &worktree_path, &source_branch, &branch_name, &git_configs)
}

pub(crate) async fn ensure_top_level_worktree(
    pool: &SqlitePool,
    work_item_id: &str,
) -> Result<WorkItemGitInfo, String> {
    let work_item = fetch_work_item_git_info(pool, work_item_id).await?;
    if work_item.parent_id.is_some() || work_item.repo_path.is_none() {
        return Ok(work_item);
    }

    let repo_path = work_item.repo_path.as_deref().unwrap_or_default().to_string();
    let branch_name = work_item
        .branch_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("mozzie/{work_item_id}"));
    validate_branch_name(&branch_name)?;

    let source_branch = work_item
        .source_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(current_branch_name(&repo_path)?.branch_name);

    let info = create_worktree(
        work_item_id.to_string(),
        repo_path,
        Some(source_branch),
        Some(branch_name),
    )
    .await?;
    let now = now_iso();
    sqlx::query(
        "UPDATE work_items SET source_branch = ?, branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&info.source_branch)
    .bind(&info.branch_name)
    .bind(&info.worktree_path)
    .bind(&now)
    .bind(work_item_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    fetch_work_item_git_info(pool, work_item_id).await
}

#[tauri::command]
pub async fn get_work_item_review_state(
    db: State<'_, SqlitePool>,
    work_item_id: String,
) -> Result<WorkItemReviewState, String> {
    let mut work_item = fetch_work_item_git_info(db.inner(), &work_item_id).await?;
    if work_item.parent_id.is_none()
        && work_item.repo_path.is_some()
        && (work_item.branch_name.is_none()
            || work_item.worktree_path.is_none()
            || work_item
                .worktree_path
                .as_deref()
                .map(|path| !has_valid_worktree(path))
                .unwrap_or(true))
    {
        work_item = ensure_top_level_worktree(db.inner(), &work_item_id).await?;
    }
    Ok(compute_review_state(&work_item))
}

#[tauri::command]
pub async fn approve_work_item_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    let mut work_item = fetch_work_item_git_info(db.inner(), &work_item_id).await?;
    if work_item.parent_id.is_none() {
        work_item = ensure_top_level_worktree(db.inner(), &work_item_id).await?;
    }
    let from_status = work_item.status.clone();
    let repo_path = work_item.repo_path.as_deref().ok_or("Work item has no repo_path")?;
    let branch_name = work_item.branch_name.as_deref().ok_or("Work item has no branch_name")?;
    let worktree_path = work_item.worktree_path.as_deref();

    let _ = shutdown_work_item_session(active_sessions.inner(), &work_item_id).await;

    if !branch_exists(repo_path, branch_name) {
        return Err(format!(
            "Work item branch '{branch_name}' is missing. Cannot approve."
        ));
    }

    let git_configs = crate::commands::workspaces::get_workspace_git_configs(
        db.inner(),
        &work_item.workspace_id,
    )
    .await;

    // Commit any uncommitted work so the merge/push includes everything the agent produced.
    if let Some(worktree_path) = worktree_path.filter(|path| has_valid_worktree(path)) {
        let _ = commit_pending_changes(worktree_path, branch_name, &git_configs);
    }

    if let Some(ref parent_id) = work_item.parent_id {
        // ── Child work item: merge into the parent's branch ──
        let parent = ensure_top_level_worktree(db.inner(), parent_id).await?;
        let parent_branch = parent.branch_name.as_deref()
            .ok_or("Parent work item has no branch_name. Cannot merge child.")?;
        let child_worktree_path = work_item
            .worktree_path
            .as_deref()
            .ok_or("Child work item has no worktree_path")?;

        // Merge child branch into parent branch
        merge_branch_internal(repo_path, child_worktree_path, parent_branch, branch_name, &git_configs)?;

        // Clean up the child's worktree
        let _ = remove_worktree_internal(child_worktree_path, repo_path, branch_name);

        // Mark child as done
        let now = now_iso();
        sqlx::query(
            r#"UPDATE work_items SET
                status = 'done', terminal_slot = NULL,
                completed_at = ?, updated_at = ?
              WHERE id = ?"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(&work_item_id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;

        app.emit(
            "work-item:state-change",
            serde_json::json!({
                "workItemId": work_item_id,
                "from": from_status,
                "to": "done",
            }),
        )
        .map_err(|e| e.to_string())?;

        if let Some(parent_worktree_path) = parent.worktree_path.as_deref() {
            let _ = sync_worktree_to_branch(parent_worktree_path, parent_branch);
        }
        sqlx::query("UPDATE work_items SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(parent_id)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit(
            "work-item:git-state-change",
            serde_json::json!({ "workItemId": parent_id }),
        );

        // Check if all children are now done → transition parent to review
        if all_children_done(db.inner(), parent_id).await? {
            let parent_from = parent.status.clone();
            if !matches!(parent_from.as_str(), "done" | "archived" | "review") {
                sqlx::query(
                    "UPDATE work_items SET status = 'review', updated_at = ? WHERE id = ?",
                )
                .bind(&now)
                .bind(parent_id)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;

                let _ = app.emit(
                    "work-item:state-change",
                    serde_json::json!({
                        "workItemId": parent_id,
                        "from": parent_from,
                        "to": "review",
                    }),
                );

                let _ = app.emit(
                    "work-item:children-complete",
                    serde_json::json!({ "parentId": parent_id }),
                );
            }
        }
    } else {
        // ── Top-level work item: push its branch without changing completion state ──
        let push_target = if let Some(worktree_path) = worktree_path.filter(|path| has_valid_worktree(path)) {
            worktree_path
        } else {
            repo_path
        };
        run_git(&["-C", push_target, "push", "-u", "origin", branch_name])?;

        let now = now_iso();
        sqlx::query("UPDATE work_items SET pushed_at = ?, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&now)
        .bind(&work_item_id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
        let _ = app.emit(
            "work-item:git-state-change",
            serde_json::json!({ "workItemId": work_item_id }),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn reject_work_item_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    let work_item = fetch_work_item_git_info(db.inner(), &work_item_id).await?;
    if work_item.parent_id.is_none() {
        return Err("Discard is only supported for child work items. Top-level work items can be pushed or marked done.".to_string());
    }
    let from_status = work_item.status.clone();

    let _ = shutdown_work_item_session(active_sessions.inner(), &work_item_id).await;

    if let (Some(repo_path), Some(worktree_path), Some(branch_name)) = (
        work_item.repo_path.as_deref(),
        work_item.worktree_path.as_deref(),
        work_item.branch_name.as_deref(),
    ) {
        remove_worktree_internal(worktree_path, repo_path, branch_name)?;
    }

    let now = now_iso();
    sqlx::query(
        r#"UPDATE work_items SET
            status = 'ready', terminal_slot = NULL,
            started_at = NULL, completed_at = NULL,
            worktree_path = NULL, source_branch = NULL, branch_name = NULL,
            updated_at = ?
          WHERE id = ?"#,
    )
    .bind(&now)
    .bind(&work_item_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": work_item_id,
            "from": from_status,
            "to": "ready",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_work_item_review(
    app: AppHandle,
    db: State<'_, SqlitePool>,
    active_sessions: State<'_, ActiveSessions>,
    work_item_id: String,
) -> Result<(), String> {
    let work_item = fetch_work_item_git_info(db.inner(), &work_item_id).await?;
    if work_item.parent_id.is_some() {
        return Err("Child work items must be merged or discarded; they cannot be marked done directly.".to_string());
    }
    let from_status = work_item.status.clone();
    let now = now_iso();

    let _ = shutdown_work_item_session(active_sessions.inner(), &work_item_id).await;

    sqlx::query(
        r#"UPDATE work_items SET
            status = 'done', terminal_slot = NULL,
            completed_at = ?, updated_at = ?
          WHERE id = ?"#,
    )
    .bind(&now)
    .bind(&now)
    .bind(&work_item_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;

    app.emit(
        "work-item:state-change",
        serde_json::json!({
            "workItemId": work_item_id,
            "from": from_status,
            "to": "done",
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Ensures a parent work item's branch exists in the repo (without a worktree).
/// Called before starting a child so the child can branch off the parent's branch.
#[tauri::command]
pub async fn ensure_parent_branch(
    db: State<'_, SqlitePool>,
    parent_id: String,
) -> Result<String, String> {
    let parent = ensure_top_level_worktree(db.inner(), &parent_id).await?;
    parent
        .branch_name
        .ok_or("Parent work item has no branch_name".to_string())
}

#[tauri::command]
pub async fn get_repo_branch(repo_path: String) -> Result<RepoBranchInfo, String> {
    current_branch_name(&repo_path)
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
