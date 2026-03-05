// PTY commands — ACP replaces the full PTY layer.
// kill_process is kept as a no-op so the abort button in TerminalGrid compiles.

#[tauri::command]
pub async fn kill_process(slot: u8) -> Result<i32, String> {
    let _ = slot;
    // ACP runs complete on the agent's side; there is no OS process to kill.
    Ok(0)
}
