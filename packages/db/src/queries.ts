import { ulid } from 'ulid';
import type { WorkItem, AgentLog, AgentConfig, WorkItemStatus } from './schema.js';

export type SqlQuery = { sql: string; params: unknown[] };

export function insertWorkItem(
  workItem: Omit<WorkItem, 'id' | 'created_at' | 'updated_at'>
): SqlQuery {
  const id = ulid();
  const now = new Date().toISOString();
  return {
    sql: `INSERT INTO work_items (
      id, title, context, status,
      repo_path, source_branch, branch_name, worktree_path, assigned_agent, terminal_slot,
      created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      workItem.title,
      workItem.context,
      workItem.status,
      workItem.repo_path,
      workItem.source_branch,
      workItem.branch_name,
      workItem.worktree_path,
      workItem.assigned_agent,
      workItem.terminal_slot,
      now,
      now,
      workItem.started_at,
      workItem.completed_at,
    ],
  };
}

export function updateWorkItem(id: string, fields: Partial<WorkItem>): SqlQuery {
  const now = new Date().toISOString();
  const updates = { ...fields, updated_at: now };
  delete updates.id;
  delete updates.created_at;

  const keys = Object.keys(updates) as (keyof typeof updates)[];
  const setClauses = keys.map((k) => `${k} = ?`).join(', ');
  const params = [...keys.map((k) => updates[k]), id];

  return {
    sql: `UPDATE work_items SET ${setClauses} WHERE id = ?`,
    params,
  };
}

export function listWorkItems(filters?: { status?: WorkItemStatus[] }): SqlQuery {
  if (filters?.status && filters.status.length > 0) {
    const placeholders = filters.status.map(() => '?').join(', ');
    return {
      sql: `SELECT * FROM work_items WHERE status IN (${placeholders}) ORDER BY updated_at DESC`,
      params: filters.status,
    };
  }
  return {
    sql: `SELECT * FROM work_items ORDER BY updated_at DESC`,
    params: [],
  };
}

export function getWorkItem(id: string): SqlQuery {
  return {
    sql: `SELECT * FROM work_items WHERE id = ?`,
    params: [id],
  };
}

export function insertAgentLog(
  log: Omit<AgentLog, 'id' | 'created_at'>
): SqlQuery {
  const id = ulid();
  const now = new Date().toISOString();
  return {
    sql: `INSERT INTO agent_logs (
      id, work_item_id, agent_id, run_id, messages, summary,
      tokens_in, tokens_out, cost_usd, exit_code, duration_ms,
      cleanup_warning, cleanup_warning_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      log.work_item_id,
      log.agent_id,
      log.run_id,
      log.messages,
      log.summary,
      log.tokens_in,
      log.tokens_out,
      log.cost_usd,
      log.exit_code,
      log.duration_ms,
      log.cleanup_warning,
      log.cleanup_warning_message,
      now,
    ],
  };
}

export function getAgentLogs(workItemId: string): SqlQuery {
  return {
    sql: `SELECT * FROM agent_logs WHERE work_item_id = ? ORDER BY created_at ASC`,
    params: [workItemId],
  };
}

export function listAgentConfigs(): SqlQuery {
  return {
    sql: `SELECT * FROM agent_config ORDER BY display_name ASC`,
    params: [],
  };
}

export function upsertAgentConfig(config: AgentConfig): SqlQuery {
  return {
    sql: `INSERT INTO agent_config (
      id, display_name, acp_url, api_key_ref, model, max_concurrent, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name   = excluded.display_name,
      acp_url        = excluded.acp_url,
      api_key_ref    = excluded.api_key_ref,
      model          = excluded.model,
      max_concurrent = excluded.max_concurrent,
      enabled        = excluded.enabled`,
    params: [
      config.id,
      config.display_name,
      config.acp_url,
      config.api_key_ref,
      config.model,
      config.max_concurrent,
      config.enabled,
    ],
  };
}
