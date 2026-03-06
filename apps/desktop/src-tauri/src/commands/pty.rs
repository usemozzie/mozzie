use tauri::State;

use crate::commands::agents::{interrupt_agent, ActiveRuns};

#[tauri::command]
pub async fn kill_process(active_runs: State<'_, ActiveRuns>, slot: u8) -> Result<i32, String> {
    let ticket_id = {
        let runs = active_runs
            .0
            .lock()
            .map_err(|_| "Active run state is unavailable".to_string())?;
        runs.iter()
            .find(|(_, handle)| handle.slot == slot)
            .map(|(ticket_id, _)| ticket_id.clone())
    };

    if let Some(ticket_id) = ticket_id {
        interrupt_agent(active_runs, ticket_id).await?;
    }

    Ok(0)
}
