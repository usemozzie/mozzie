mod commands;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("mozzie.db");

            let pool = tauri::async_runtime::block_on(async {
                let opts = SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true);
                let pool = SqlitePool::connect_with(opts).await?;

                // Run migrations eagerly so tables exist before any Rust command fires.
                // Keep SQLx as the single migration path; registering the same SQL with
                // tauri-plugin-sql causes legacy ticket -> work_item upgrades to race with
                // fresh-table creation and fail during startup.

                // Handle legacy "tickets" table from older app versions.
                let has_tickets_table: i32 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tickets'"
                )
                .fetch_one(&pool)
                .await
                .unwrap_or(0);
                let has_work_items_table: i32 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='work_items'"
                )
                .fetch_one(&pool)
                .await
                .unwrap_or(0);

                if has_tickets_table > 0 && has_work_items_table > 0 {
                    // Both tables exist — the old installed app created a stale `tickets`
                    // table alongside the real `work_items`. Just drop the stale one.
                    let _ = sqlx::raw_sql("DROP TABLE IF EXISTS tickets")
                        .execute(&pool)
                        .await;
                    let _ = sqlx::raw_sql("DROP TABLE IF EXISTS ticket_dependencies")
                        .execute(&pool)
                        .await;
                    let _ = sqlx::raw_sql("DROP TABLE IF EXISTS ticket_attempts")
                        .execute(&pool)
                        .await;
                } else if has_tickets_table > 0 {
                    // Only `tickets` exists (genuine pre-rename database) — rename in place.
                    let _ = sqlx::raw_sql("DROP TABLE IF EXISTS work_item_dependencies")
                        .execute(&pool)
                        .await;
                    let _ = sqlx::raw_sql("DROP TABLE IF EXISTS work_item_attempts")
                        .execute(&pool)
                        .await;
                    sqlx::raw_sql(
                        "ALTER TABLE tickets RENAME TO work_items;\
                         ALTER TABLE work_items RENAME COLUMN duplicate_of_ticket_id TO duplicate_of_work_item_id;\
                         ALTER TABLE agent_logs RENAME COLUMN ticket_id TO work_item_id;\
                         ALTER TABLE ticket_dependencies RENAME TO work_item_dependencies;\
                         ALTER TABLE work_item_dependencies RENAME COLUMN ticket_id TO work_item_id;\
                         ALTER TABLE ticket_attempts RENAME TO work_item_attempts;\
                         ALTER TABLE work_item_attempts RENAME COLUMN ticket_id TO work_item_id;"
                    )
                    .execute(&pool)
                    .await?;
                }

                sqlx::raw_sql(include_str!("../migrations/001_tickets.sql"))
                    .execute(&pool)
                    .await?;
                sqlx::raw_sql(include_str!("../migrations/002_agent_logs.sql"))
                    .execute(&pool)
                    .await?;

                // Idempotent column additions for databases created before the ACP rewrite.
                // Must run BEFORE migration 003 because its INSERT OR IGNORE references acp_url.
                // Errors are silently ignored when the column already exists (new DB) or
                // when the table doesn't exist yet (brand-new install handled by 003 below).
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN acp_url TEXT NOT NULL DEFAULT 'builtin:claude-code';"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_logs ADD COLUMN run_id TEXT;"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_logs ADD COLUMN messages TEXT;"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN source_branch TEXT;"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_logs ADD COLUMN cleanup_warning INTEGER;"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_logs ADD COLUMN cleanup_warning_message TEXT;"
                )
                .execute(&pool)
                .await;

                // Create agent_config table and seed defaults (no-op if table already exists).
                sqlx::raw_sql(include_str!("../migrations/003_agent_config.sql"))
                    .execute(&pool)
                    .await?;

                // Create repos table (no-op if already exists).
                sqlx::raw_sql(include_str!("../migrations/004_repos.sql"))
                    .execute(&pool)
                    .await?;

                // Create workspaces tables, seed default workspace.
                sqlx::raw_sql(include_str!("../migrations/005_workspaces.sql"))
                    .execute(&pool)
                    .await?;

                // Add workspace_id to work_items and repos (idempotent).
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';"
                )
                .execute(&pool)
                .await;

                let _ = sqlx::raw_sql(
                    "ALTER TABLE repos ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';"
                )
                .execute(&pool)
                .await;

                // Migrate legacy HTTP bridge targets to built-in stdio aliases.
                sqlx::raw_sql(
                    "UPDATE agent_config SET acp_url = 'builtin:claude-code' \
                     WHERE id = 'claude-code' AND acp_url = 'http://localhost:8330'; \
                     UPDATE agent_config SET acp_url = 'builtin:gemini-cli' \
                     WHERE id = 'gemini-cli' AND acp_url = 'http://localhost:8331'; \
                     UPDATE agent_config SET acp_url = 'builtin:codex-cli' \
                     WHERE id = 'codex-cli' AND acp_url = 'http://localhost:8332';",
                )
                .execute(&pool)
                .await?;

                // Create work_item_dependencies table (no-op if already exists).
                sqlx::raw_sql(include_str!("../migrations/006_ticket_dependencies.sql"))
                    .execute(&pool)
                    .await?;

                // Orchestrator v3 metadata columns (idempotent).
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN execution_context TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN orchestrator_note TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN duplicate_of_work_item_id TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN duplicate_policy TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN intent_type TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN strengths TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN weaknesses TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN best_for TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN reasoning_class TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN speed_class TEXT;"
                )
                .execute(&pool)
                .await;
                let _ = sqlx::raw_sql(
                    "ALTER TABLE agent_config ADD COLUMN edit_reliability TEXT;"
                )
                .execute(&pool)
                .await;

                // Create work_item_attempts table (no-op if already exists).
                sqlx::raw_sql(include_str!("../migrations/008_attempt_history.sql"))
                    .execute(&pool)
                    .await?;

                // Create conversations + conversation_messages tables (no-op if already exists).
                sqlx::raw_sql(include_str!("../migrations/009_conversations.sql"))
                    .execute(&pool)
                    .await?;

                // Sub-work-item parent_id column (idempotent).
                let _ = sqlx::raw_sql(
                    "ALTER TABLE work_items ADD COLUMN parent_id TEXT REFERENCES work_items(id);"
                )
                .execute(&pool)
                .await;

                // Create agent_log_events table for durable streamed ACP event persistence.
                sqlx::raw_sql(include_str!("../migrations/012_agent_log_events.sql"))
                    .execute(&pool)
                    .await?;

                // On every startup, reset work items that were left mid-flight from a previous
                // session. ACP streams and terminal store state are not persisted across
                // restarts, so queued/running work items would be stuck indefinitely.
                // worktree_path and branch_name are intentionally kept so the user can
                // resume or inspect the work; terminal_slot is cleared since slots are
                // re-allocated fresh each session.
                // Blocked work items stay blocked — their deps haven't changed.
                sqlx::raw_sql(
                    "UPDATE work_items \
                     SET status = 'ready', terminal_slot = NULL, updated_at = datetime('now') \
                     WHERE status IN ('queued', 'running')",
                )
                .execute(&pool)
                .await?;

                Ok::<_, sqlx::Error>(pool)
            })?;

            app.manage(pool);
            app.manage(commands::agents::ActiveSessions::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY minimal stub (ACP replaces full PTY)
            commands::pty::kill_process,
            // Work Items (Task C)
            commands::work_items::create_work_item,
            commands::work_items::update_work_item,
            commands::work_items::list_work_items,
            commands::work_items::get_work_item,
            commands::work_items::transition_work_item,
            commands::work_items::archive_work_item,
            commands::work_items::close_work_item,
            commands::work_items::reopen_work_item,
            commands::work_items::delete_work_item,
            commands::work_items::find_similar_work_items,
            commands::work_items::search_repo_files,
            commands::work_items::add_work_item_dependency,
            commands::work_items::remove_work_item_dependency,
            commands::work_items::get_work_item_dependencies,
            commands::work_items::get_work_item_dependents,
            commands::work_items::has_unmet_dependencies,
            commands::work_items::get_work_item_attempts,
            commands::work_items::record_work_item_attempt,
            commands::work_items::get_child_work_items,
            // Worktree (Task D)
            commands::worktree::create_worktree,
            commands::worktree::remove_worktree,
            commands::worktree::get_diff,
            commands::worktree::merge_branch,
            commands::worktree::get_work_item_review_state,
            commands::worktree::approve_work_item_review,
            commands::worktree::reject_work_item_review,
            commands::worktree::close_work_item_review,
            commands::worktree::ensure_parent_branch,
            commands::worktree::get_repo_branch,
            commands::worktree::list_repo_branches,
            // Orchestrator LLM
            commands::orchestrator::plan_orchestrator_actions,
            commands::orchestrator::explore_repo,
            // Agents (Task D / ACP)
            commands::agents::list_agent_configs,
            commands::agents::save_agent_config,
            commands::agents::delete_agent_config,
            commands::agents::launch_agent,
            commands::agents::continue_agent,
            commands::agents::interrupt_agent,
            commands::agents::cancel_agent_turn,
            commands::agents::stop_agent_session,
            commands::agents::shutdown_all_agent_sessions,
            commands::agents::get_agent_session,
            commands::agents::set_agent_permission_policy,
            commands::agents::respond_to_agent_permission,
            commands::agents::get_agent_logs,
            commands::agents::get_acp_messages,
            commands::agents::get_work_item_acp_events,
            // Repos
            commands::repos::list_repos,
            commands::repos::add_repo,
            commands::repos::prepare_repo,
            commands::repos::checkout_repo_branch,
            commands::repos::remove_repo,
            commands::repos::update_repo_last_used,
            // Workspaces
            commands::workspaces::list_workspaces,
            commands::workspaces::create_workspace,
            commands::workspaces::rename_workspace,
            commands::workspaces::delete_workspace,
            // Notes
            commands::notes::get_workspace_notes,
            commands::notes::save_workspace_notes,
            // Conversations
            commands::conversations::list_conversations,
            commands::conversations::get_conversation,
            commands::conversations::create_conversation,
            commands::conversations::delete_conversation,
            commands::conversations::list_conversation_messages,
            commands::conversations::append_conversation_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
