use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;
use ulid::Ulid;

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn new_id() -> String {
    Ulid::new().to_string()
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Conversation {
    pub id: String,
    pub workspace_id: String,
    pub title: Option<String>,
    pub pinned: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ConversationMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub text: String,
    pub metadata: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_conversations(
    pool: State<'_, SqlitePool>,
    workspace_id: String,
) -> Result<Vec<Conversation>, String> {
    sqlx::query_as::<_, Conversation>(
        "SELECT id, workspace_id, title, pinned, created_at, updated_at \
         FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC",
    )
    .bind(&workspace_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_conversation(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Conversation, String> {
    sqlx::query_as::<_, Conversation>(
        "SELECT id, workspace_id, title, pinned, created_at, updated_at \
         FROM conversations WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    pool: State<'_, SqlitePool>,
    workspace_id: String,
    title: Option<String>,
) -> Result<Conversation, String> {
    let id = new_id();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO conversations (id, workspace_id, title, pinned, created_at, updated_at) \
         VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(&workspace_id)
    .bind(&title)
    .bind(&now)
    .bind(&now)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(Conversation {
        id,
        workspace_id,
        title,
        pinned: 0,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn delete_conversation(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    // Messages cascade-deleted via FK.
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_conversation_messages(
    pool: State<'_, SqlitePool>,
    conversation_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    sqlx::query_as::<_, ConversationMessage>(
        "SELECT id, conversation_id, role, text, metadata, created_at \
         FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(&conversation_id)
    .fetch_all(pool.inner())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn append_conversation_message(
    pool: State<'_, SqlitePool>,
    conversation_id: String,
    role: String,
    text: String,
    metadata: Option<String>,
) -> Result<ConversationMessage, String> {
    let id = new_id();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO conversation_messages (id, conversation_id, role, text, metadata, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&conversation_id)
    .bind(&role)
    .bind(&text)
    .bind(&metadata)
    .bind(&now)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    // Touch conversation updated_at.
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&conversation_id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    Ok(ConversationMessage {
        id,
        conversation_id,
        role,
        text,
        metadata,
        created_at: now,
    })
}
