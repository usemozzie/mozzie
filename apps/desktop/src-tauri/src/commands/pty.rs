use tauri::State;

use crate::commands::agents::{stop_agent_session, ActiveSessions};

#[tauri::command]
pub async fn kill_process(active_sessions: State<'_, ActiveSessions>, slot: u8) -> Result<i32, String> {
    let ticket_id = {
        let sessions = active_sessions
            .0
            .lock()
            .map_err(|_| "Active session state is unavailable".to_string())?;
        sessions.iter()
            .find(|(_, handle)| handle.current_slot() == Some(slot))
            .map(|(ticket_id, _)| ticket_id.clone())
    };

    if let Some(ticket_id) = ticket_id {
        stop_agent_session(active_sessions, ticket_id).await?;
    }

    Ok(0)
}
