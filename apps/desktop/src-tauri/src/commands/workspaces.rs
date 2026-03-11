use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;
use ulid::Ulid;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub git_user_name: Option<String>,
    pub git_user_email: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[tauri::command]
pub async fn list_workspaces(pool: State<'_, SqlitePool>) -> Result<Vec<Workspace>, String> {
    sqlx::query_as::<_, Workspace>(
        "SELECT id, name, git_user_name, git_user_email, created_at, updated_at FROM workspaces ORDER BY created_at ASC",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_workspace(
    pool: State<'_, SqlitePool>,
    name: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Workspace name cannot be empty".to_string());
    }

    let id = Ulid::new().to_string();
    let now = now_iso();

    sqlx::query("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Workspace>("SELECT id, name, git_user_name, git_user_email, created_at, updated_at FROM workspaces WHERE id = ?")
        .bind(&id)
        .fetch_one(pool.inner())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_workspace(
    pool: State<'_, SqlitePool>,
    id: String,
    name: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Workspace name cannot be empty".to_string());
    }

    let now = now_iso();
    let result = sqlx::query("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&now)
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() == 0 {
        return Err(format!("Workspace '{}' not found", id));
    }

    sqlx::query_as::<_, Workspace>("SELECT id, name, git_user_name, git_user_email, created_at, updated_at FROM workspaces WHERE id = ?")
        .bind(&id)
        .fetch_one(pool.inner())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_workspace_git_identity(
    pool: State<'_, SqlitePool>,
    id: String,
    git_user_name: Option<String>,
    git_user_email: Option<String>,
) -> Result<Workspace, String> {
    let name = git_user_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let email = git_user_email
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let now = now_iso();

    let result = sqlx::query(
        "UPDATE workspaces SET git_user_name = ?, git_user_email = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&email)
    .bind(&now)
    .bind(&id)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    if result.rows_affected() == 0 {
        return Err(format!("Workspace '{}' not found", id));
    }

    sqlx::query_as::<_, Workspace>(
        "SELECT id, name, git_user_name, git_user_email, created_at, updated_at FROM workspaces WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Fetch git identity configs for a workspace. Returns configs suitable for
/// `run_git_with_configs`. If no workspace identity is set, returns empty vec
/// so git falls through to the repo's own config.
pub(crate) async fn get_workspace_git_configs(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Vec<String> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT git_user_name, git_user_email FROM workspaces WHERE id = ?",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let mut configs = Vec::new();
    if let Some((name, email)) = row {
        if let Some(n) = name.filter(|s| !s.is_empty()) {
            configs.push(format!("user.name={n}"));
        }
        if let Some(e) = email.filter(|s| !s.is_empty()) {
            configs.push(format!("user.email={e}"));
        }
    }
    configs
}

#[tauri::command]
pub async fn delete_workspace(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    if id == "default" {
        return Err("Cannot delete the default workspace".to_string());
    }

    // Check for remaining work items
    let work_item_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM work_items WHERE workspace_id = ?")
            .bind(&id)
            .fetch_one(pool.inner())
            .await
            .map_err(|e| e.to_string())?;

    if work_item_count > 0 {
        return Err(format!(
            "Cannot delete workspace with {} work item(s). Move or delete them first.",
            work_item_count
        ));
    }

    // Delete repos associated with this workspace
    sqlx::query("DELETE FROM repos WHERE workspace_id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
