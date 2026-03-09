use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;
use ulid::Ulid;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
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
        "SELECT id, name, created_at, updated_at FROM workspaces ORDER BY created_at ASC",
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

    sqlx::query_as::<_, Workspace>("SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?")
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

    sqlx::query_as::<_, Workspace>("SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?")
        .bind(&id)
        .fetch_one(pool.inner())
        .await
        .map_err(|e| e.to_string())
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
