use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

fn worktrees_base() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".mozzie").join("worktrees")
}

fn run_git(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;
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

/// Create a git worktree for the given ticket.
/// Idempotent: if the worktree already exists and is functional, returns it as-is.
/// If stale state is detected (branch exists, directory orphaned, etc.) it is
/// cleaned up automatically before creating a fresh worktree.
///
/// Worktree path: ~/.mozzie/worktrees/{ticket_id}/
/// Branch name:   provided by caller, or fallback to mozzie/{ticket_id}
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
        _ => run_git(&["-C", &repo_path, "rev-parse", "--abbrev-ref", "HEAD"])?,
    };

    // Fast path: worktree directory exists and git considers it valid → return as-is.
    if worktree_path.exists()
        && run_git(&["-C", &worktree_str, "rev-parse", "--git-dir"]).is_ok()
    {
        return Ok(WorktreeInfo {
            worktree_path: worktree_str,
            branch_name,
            source_branch: source,
        });
    }

    // Cleanup any stale state so we can create a fresh worktree.
    // All of these are best-effort; errors are silently ignored.
    let _ = run_git(&["-C", &repo_path, "worktree", "remove", "--force", &worktree_str]);
    let _ = run_git(&["-C", &repo_path, "branch", "-D", &branch_name]);
    let _ = run_git(&["-C", &repo_path, "worktree", "prune"]);
    // Remove the directory in case it exists but is not a registered worktree.
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

/// Remove a git worktree and delete its branch.
/// Best-effort: if the worktree path is already gone, still tries to delete the branch.
#[tauri::command]
pub async fn remove_worktree(
    worktree_path: String,
    repo_path: String,
    branch_name: String,
) -> Result<(), String> {
    // Ignore error if worktree already removed
    let _ = run_git(&[
        "-C",
        &repo_path,
        "worktree",
        "remove",
        "--force",
        &worktree_path,
    ]);
    run_git(&["-C", &repo_path, "branch", "-D", &branch_name])?;
    Ok(())
}

/// Compute the diff between the source branch and the current worktree contents.
/// This includes uncommitted tracked-file changes. Untracked files are listed
/// separately because plain `git diff` does not render them.
#[tauri::command]
pub async fn get_diff(
    worktree_path: String,
    source_branch: Option<String>,
) -> Result<String, String> {
    let base = match source_branch {
        Some(s) if !s.trim().is_empty() => s,
        _ => "HEAD".to_string(),
    };

    let mut diff = run_git(&["-C", &worktree_path, "diff", "--no-ext-diff", &base])?;
    let untracked = run_git(&[
        "-C",
        &worktree_path,
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

/// Commit pending worktree changes (if any), then merge the ticket branch into
/// the stored source branch.
#[tauri::command]
pub async fn merge_branch(
    repo_path: String,
    worktree_path: String,
    source_branch: String,
    branch_name: String,
) -> Result<(), String> {
    let status = run_git(&["-C", &worktree_path, "status", "--porcelain"])?;

    if !status.is_empty() {
        run_git(&["-C", &worktree_path, "add", "-A"])?;
        run_git_with_configs(
            &worktree_path,
            &["user.name=Mozzie", "user.email=mozzie@local"],
            &["commit", "--no-verify", "-m", &format!("Mozzie: checkpoint {branch_name}")],
        )?;
    }

    run_git(&["-C", &repo_path, "checkout", &source_branch])?;
    run_git(&["-C", &repo_path, "merge", "--no-ff", &branch_name])?;
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

/// List local branch names for a repo, with the current branch first.
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

    // Put current branch first if it exists in the list
    if !current.is_empty() && current != "HEAD" {
        if let Some(pos) = branches.iter().position(|b| b == &current) {
            branches.remove(pos);
        }
        branches.insert(0, current);
    }

    Ok(branches)
}
