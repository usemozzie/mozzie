use sqlx::SqlitePool;
use tauri::State;

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[tauri::command]
pub async fn get_workspace_notes(
    pool: State<'_, SqlitePool>,
    workspace_id: String,
) -> Result<String, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT content FROM workspace_notes WHERE workspace_id = ?")
            .bind(&workspace_id)
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| e.to_string())?;

    Ok(row.map(|(c,)| c).unwrap_or_default())
}

#[tauri::command]
pub async fn save_workspace_notes(
    pool: State<'_, SqlitePool>,
    workspace_id: String,
    content: String,
) -> Result<(), String> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO workspace_notes (workspace_id, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    )
    .bind(&workspace_id)
    .bind(&content)
    .bind(&now)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
