mod commands;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_tickets_table",
            sql: include_str!("../migrations/001_tickets.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_agent_logs_table",
            sql: include_str!("../migrations/002_agent_logs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_agent_config_table",
            sql: include_str!("../migrations/003_agent_config.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:mozzie.db", migrations)
                .build(),
        )
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
                // tauri-plugin-sql only runs migrations when the frontend calls
                // Database.load(), which may happen after the first invoke.
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
                    "ALTER TABLE tickets ADD COLUMN source_branch TEXT;"
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

                // On every startup, reset tickets that were left mid-flight from a previous
                // session. ACP streams and terminal store state are not persisted across
                // restarts, so queued/running tickets would be stuck indefinitely.
                // worktree_path and branch_name are intentionally kept so the user can
                // resume or inspect the work; terminal_slot is cleared since slots are
                // re-allocated fresh each session.
                sqlx::raw_sql(
                    "UPDATE tickets \
                     SET status = 'ready', terminal_slot = NULL, updated_at = datetime('now') \
                     WHERE status IN ('queued', 'running')",
                )
                .execute(&pool)
                .await?;

                Ok::<_, sqlx::Error>(pool)
            })?;

            app.manage(pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY minimal stub (ACP replaces full PTY)
            commands::pty::kill_process,
            // Tickets (Task C)
            commands::tickets::create_ticket,
            commands::tickets::update_ticket,
            commands::tickets::list_tickets,
            commands::tickets::get_ticket,
            commands::tickets::transition_ticket,
            commands::tickets::archive_ticket,
            commands::tickets::delete_ticket,
            commands::tickets::search_repo_files,
            // Worktree (Task D)
            commands::worktree::create_worktree,
            commands::worktree::remove_worktree,
            commands::worktree::get_diff,
            commands::worktree::merge_branch,
            commands::worktree::get_repo_branch,
            commands::worktree::list_repo_branches,
            // Orchestrator LLM
            commands::orchestrator::plan_orchestrator_actions,
            // Agents (Task D / ACP)
            commands::agents::list_agent_configs,
            commands::agents::save_agent_config,
            commands::agents::delete_agent_config,
            commands::agents::launch_agent,
            commands::agents::continue_agent,
            commands::agents::get_agent_logs,
            commands::agents::get_acp_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
