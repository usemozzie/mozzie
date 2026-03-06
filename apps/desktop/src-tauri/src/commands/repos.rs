use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub default_branch: Option<String>,
    pub last_used_at: Option<String>,
    pub workspace_id: String,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for Repo {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> sqlx::Result<Self> {
        Ok(Repo {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            path: row.try_get("path")?,
            default_branch: row.try_get("default_branch")?,
            last_used_at: row.try_get("last_used_at")?,
            workspace_id: row.try_get::<String, _>("workspace_id").unwrap_or_else(|_| "default".to_string()),
            created_at: row.try_get("created_at")?,
        })
    }
}

#[tauri::command]
pub async fn list_repos(
    pool: State<'_, SqlitePool>,
    workspace_id: Option<String>,
) -> Result<Vec<Repo>, String> {
    let ws = workspace_id.unwrap_or_else(|| "default".to_string());
    sqlx::query_as::<_, Repo>(
        "SELECT * FROM repos WHERE workspace_id = ? ORDER BY last_used_at DESC, created_at DESC",
    )
    .bind(&ws)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_repo(
    name: String,
    path: String,
    workspace_id: Option<String>,
    pool: State<'_, SqlitePool>,
) -> Result<Repo, String> {
    // Validate path exists and is a git repo
    let repo_path = std::path::Path::new(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Err(format!("Not a git repository: {}", path));
    }

    // Detect default branch
    let default_branch = detect_default_branch(&path);
    let ws = workspace_id.unwrap_or_else(|| "default".to_string());

    let id = ulid::Ulid::new().to_string();
    sqlx::query(
        "INSERT INTO repos (id, name, path, default_branch, workspace_id) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&name)
    .bind(&path)
    .bind(&default_branch)
    .bind(&ws)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Repo>("SELECT * FROM repos WHERE id = ?")
        .bind(&id)
        .fetch_one(pool.inner())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_repo(id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    sqlx::query("DELETE FROM repos WHERE id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_repo_last_used(id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    sqlx::query("UPDATE repos SET last_used_at = datetime('now') WHERE id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn detect_default_branch(path: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(path)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // strip "origin/" prefix
        Some(branch.strip_prefix("origin/").unwrap_or(&branch).to_string())
    } else {
        // Fallback: check if main or master exists
        let output = std::process::Command::new("git")
            .args(["branch", "--list", "main", "master"])
            .current_dir(path)
            .output()
            .ok()?;
        let branches = String::from_utf8_lossy(&output.stdout);
        if branches.contains("main") {
            Some("main".to_string())
        } else if branches.contains("master") {
            Some("master".to_string())
        } else {
            None
        }
    }
}
