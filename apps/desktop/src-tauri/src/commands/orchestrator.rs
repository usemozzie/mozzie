use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorActionKind {
    Summary,
    CreateTickets,
    StartTicket,
    RunAllReady,
    CloseTickets,
    ReopenTickets,
    DeleteTickets,
    AnalyzeAndPlan,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorTicketSpec {
    pub title: String,
    pub context: String,
    pub execution_context: Option<String>,
    pub orchestrator_note: Option<String>,
    pub repo_path: Option<String>,
    pub assigned_agent: Option<String>,
    pub depends_on_titles: Option<Vec<String>>,
    pub duplicate_of_ticket_id: Option<String>,
    pub duplicate_policy: Option<String>,
    pub intent_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorAction {
    pub kind: OrchestratorActionKind,
    pub ticket_id: Option<String>,
    pub ticket_ids: Option<Vec<String>>,
    pub tickets: Option<Vec<OrchestratorTicketSpec>>,
    pub repo_path: Option<String>,
    pub objective: Option<String>,
    pub repo_paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnalysisWorkItem {
    pub title: String,
    pub description: String,
    pub files: Option<Vec<String>>,
    pub depends_on: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorPlan {
    pub assistant_message: String,
    pub actions: Vec<OrchestratorAction>,
}

#[tauri::command]
pub async fn plan_orchestrator_actions(
    provider: String,
    api_key: String,
    model: String,
    message: String,
    workspace_id: String,
    tickets_json: String,
    history_json: String,
    repos_json: String,
    agents_json: String,
    recent_repos_json: String,
) -> Result<OrchestratorPlan, String> {
    if api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }

    if model.trim().is_empty() {
        return Err("Model is required".to_string());
    }

    let prompt = build_prompt(
        &message,
        &workspace_id,
        &tickets_json,
        &history_json,
        &repos_json,
        &agents_json,
        &recent_repos_json,
    )?;
    let raw = match provider.as_str() {
        "openai" => call_openai(&api_key, &model, &prompt).await?,
        "anthropic" => call_anthropic(&api_key, &model, &prompt).await?,
        "gemini" => call_gemini(&api_key, &model, &prompt).await?,
        _ => return Err(format!("Unsupported provider '{provider}'")),
    };

    let cleaned = clean_json_response(&raw);
    serde_json::from_str::<OrchestratorPlan>(&cleaned)
        .map_err(|err| format!("Failed to parse orchestrator response: {err}. Raw: {cleaned}"))
}

fn build_prompt(
    message: &str,
    workspace_id: &str,
    tickets_json: &str,
    history_json: &str,
    repos_json: &str,
    agents_json: &str,
    recent_repos_json: &str,
) -> Result<String, String> {
    let tickets: Value = serde_json::from_str(tickets_json)
        .map_err(|err| format!("Invalid ticket snapshot payload: {err}"))?;
    let history: Value = serde_json::from_str(history_json)
        .map_err(|err| format!("Invalid orchestrator history payload: {err}"))?;
    let repos: Value = serde_json::from_str(repos_json)
        .map_err(|err| format!("Invalid repository snapshot payload: {err}"))?;
    let agents: Value = serde_json::from_str(agents_json)
        .map_err(|err| format!("Invalid agent snapshot payload: {err}"))?;
    let recent_repos: Value = serde_json::from_str(recent_repos_json)
        .map_err(|err| format!("Invalid recent repository payload: {err}"))?;
    let repo_summaries = build_repo_summaries(&repos);
    let duplicate_candidates = build_duplicate_candidates(message, &tickets);
    let agent_profiles = build_agent_profiles(&agents);

    Ok(format!(
        r#"You are the Mozzie orchestrator.

You control tickets, not code. You decide actions, then the app executes them.
You must choose actions based on the workflow semantics below, not just the words in the user's prompt.
You are effectively a tool-using planner with the structured state below. Use that state aggressively before deciding.
You are scoped to a single active workspace. Never reason about, reference, or mutate tickets outside this workspace.

Return ONLY valid JSON. Do not wrap in markdown fences.

Schema:
{{
  "assistant_message": "short explanation for the user",
  "actions": [
    {{
      "kind": "summary" | "create_tickets" | "start_ticket" | "run_all_ready" | "close_tickets" | "reopen_tickets" | "delete_tickets" | "analyze_and_plan",
      "ticket_id": "required only for start_ticket",
      "ticket_ids": ["required only for close_tickets, reopen_tickets or delete_tickets"],
      "objective": "required only for analyze_and_plan — the goal to analyze and decompose",
      "repo_path": "primary repo path for analyze_and_plan",
      "repo_paths": ["optional array of repo paths for analyze_and_plan when multiple repos are involved"],
      "tickets": [
        {{
          "title": "required for create_tickets",
          "context": "short human-readable summary for the ticket detail view",
          "execution_context": "required agent-facing instructions for the coding agent",
          "orchestrator_note": "optional planner note for why this ticket exists",
          "repo_path": "optional absolute path or null",
          "assigned_agent": "optional or null",
          "depends_on_titles": ["optional array of ticket titles this ticket depends on"],
          "duplicate_of_ticket_id": "optional similar ticket id if this is intentionally related to an existing ticket",
          "duplicate_policy": "optional one of intentional_new_ticket | reuse_existing_ticket | reopen_existing_ticket",
          "intent_type": "optional high-level intent such as create_ticket | create_duplicate_ticket | reopen_ticket"
        }}
      ]
    }}
  ]
}}

Rules:
- The active workspace id is `{workspace_id}`. Every action must be interpreted as applying only to this workspace.
- Phrases like "all tickets", "run all", "close all", or "summarize tickets" always refer only to the tickets in the current workspace snapshot below.
- Use ticket IDs exactly as provided in the ticket snapshot.
- Ticket statuses mean:
  - `draft`: not ready to run yet
  - `ready`: ready to be started
  - `queued`: about to run
  - `running`: currently running on an agent
  - `blocked`: waiting on dependencies
  - `done`: finished or administratively closed
  - `archived`: historical, normally not acted on
- Action semantics:
  - `start_ticket` means actually start execution on an agent. Only use it when the user clearly wants work to run now.
  - `run_all_ready` means start every ticket currently in `ready`.
  - `close_tickets` means mark matching tickets as `done` without running them. Use this for requests like close, finish, mark done, not needed, no longer relevant, cancel this work, or administrative completion.
  - `reopen_tickets` means move matching done/archived tickets back into an active state. Use this for requests like reopen, resume, continue the old one.
  - `delete_tickets` means permanently remove tickets. Only use it when the user clearly wants deletion, not closure.
  - `summary` means explain the state without mutating anything.
  - `analyze_and_plan` means spawn a CLI agent to explore the codebase and return work items. Use this when the user asks to "analyze", "explore", "plan", "break down", or "figure out what needs to be done" for a feature or change that requires understanding the codebase first. Requires `objective` (what to analyze/implement) and `repo_path` (which repo to explore). Use `repo_paths` when multiple repos are involved (e.g. "analyze my app and update my landing page"). The analysis agent will read files, understand the architecture, and return parallelizable work items.
- Never use `start_ticket` when the user asks to close, finish, mark done, cancel, skip, abandon, or otherwise stop tracking a ticket.
- A close request can apply to tickets in any state. Prefer `close_tickets` over `start_ticket` for those requests.
- Never copy ticket-management language into `execution_context`. Forbidden examples: "create a ticket", "open a task", "track this", "ask the orchestrator", "create this ticket anyway".
- `execution_context` must be written as direct instructions to the coding agent that will work inside the repository.
- If the user says "create a ticket for X" and a similar ticket already exists, use duplicate candidates and status to decide:
  - active similar ticket: prefer summary or reuse unless the user explicitly wants a new one
  - done or archived similar ticket: prefer `reopen_tickets` if the user says reopen/resume/continue
  - done or archived similar ticket: prefer `create_tickets` with `duplicate_policy = intentional_new_ticket` if the user says "create it anyway", "new one", "fresh ticket", "do it again"
- If you create a new ticket despite a similar existing one, do NOT mention ticket creation mechanics in `execution_context`. Put rationale in `orchestrator_note`.
- For delete requests, do not assume immediate execution is safe. Return a delete_tickets action and a clear assistant_message; the UI will ask for confirmation.
- Prefer create_tickets when the user wants work split into independent runnable tickets.
- If the user is only asking for status or summary, return a summary action or no actions.
- Do not invent ticket IDs.
- Keep assistant_message concise.
- When creating multiple tickets where some depend on others, use depends_on_titles to reference prerequisite tickets by their exact title in the same batch. Dependencies are only set for Pro users.
- Prefer repo_path values from the repository snapshot or recent repos when creating tickets.
- If the user clearly refers to an existing repo by name, map it to the matching absolute repo_path from the repository snapshot.
- If no repo is specified by the user, prefer the first recent repo when it looks relevant.
- If the repo is ambiguous for ticket creation and multiple repositories are plausible, leave `repo_path` null so the UI can ask the user inline.
- When matching an existing ticket, use the title and status context to choose the intended ticket conservatively. If unclear, prefer a summary over a destructive action.
- Only choose `assigned_agent` values from the configured agent profiles below, and choose based on strengths, best_for, reasoning_class, speed_class, and edit_reliability.
- If agent choice is ambiguous, prefer the strongest reasoning agent for vague work and the strongest edit_reliability agent for implementation-heavy work.

Current ticket snapshot:
{tickets}

Structured duplicate candidates for the user message:
{duplicate_candidates}

Available repositories:
{repos}

Repository summaries:
{repo_summaries}

Configured agent profiles:
{agent_profiles}

Recent repositories:
{recent_repos}

Recent orchestrator chat history:
{history}

User message:
{message}"#,
        tickets = serde_json::to_string_pretty(&tickets).unwrap_or_else(|_| "[]".to_string()),
        duplicate_candidates = duplicate_candidates,
        repos = serde_json::to_string_pretty(&repos).unwrap_or_else(|_| "[]".to_string()),
        repo_summaries = repo_summaries,
        agent_profiles = agent_profiles,
        recent_repos = serde_json::to_string_pretty(&recent_repos).unwrap_or_else(|_| "[]".to_string()),
        history = serde_json::to_string_pretty(&history).unwrap_or_else(|_| "[]".to_string()),
        workspace_id = workspace_id.trim(),
        message = message.trim(),
    ))
}

fn build_duplicate_candidates(message: &str, tickets: &Value) -> String {
    let message_norm = normalize_text(message);
    let Some(items) = tickets.as_array() else {
        return "[]".to_string();
    };

    let mut scored = items
        .iter()
        .filter_map(|ticket| {
            let title = ticket.get("title")?.as_str()?.to_string();
            let title_norm = normalize_text(&title);
            if title_norm.is_empty() || message_norm.is_empty() {
                return None;
            }

            let mut score = 0_i64;
            if message_norm.contains(&title_norm) || title_norm.contains(&message_norm) {
                score += 700;
            }

            let message_tokens = message_norm.split_whitespace().collect::<std::collections::HashSet<_>>();
            let title_tokens = title_norm.split_whitespace().collect::<std::collections::HashSet<_>>();
            score += (message_tokens.intersection(&title_tokens).count() as i64) * 100;

            if score == 0 {
                return None;
            }

            Some(json!({
                "id": ticket.get("id").and_then(Value::as_str).unwrap_or_default(),
                "title": title,
                "status": ticket.get("status").and_then(Value::as_str).unwrap_or_default(),
                "repo_path": ticket.get("repo_path").and_then(Value::as_str),
                "assigned_agent": ticket.get("assigned_agent").and_then(Value::as_str),
                "score": score
            }))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| {
        b.get("score").and_then(Value::as_i64).cmp(&a.get("score").and_then(Value::as_i64))
    });
    scored.truncate(5);
    serde_json::to_string_pretty(&scored).unwrap_or_else(|_| "[]".to_string())
}

fn normalize_text(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_repo_summaries(repos: &Value) -> String {
    let Some(items) = repos.as_array() else {
        return "[]".to_string();
    };

    let summaries = items
        .iter()
        .filter_map(|repo| {
            let path = repo.get("path").and_then(Value::as_str)?;
            Some(json!({
                "path": path,
                "summary": summarize_repo(path),
            }))
        })
        .collect::<Vec<_>>();

    serde_json::to_string_pretty(&summaries).unwrap_or_else(|_| "[]".to_string())
}

fn summarize_repo(path: &str) -> String {
    let root = std::path::Path::new(path);
    let mut traits = Vec::new();
    if root.join("package.json").exists() { traits.push("node"); }
    if root.join("pnpm-workspace.yaml").exists() { traits.push("pnpm-workspace"); }
    if root.join("Cargo.toml").exists() { traits.push("rust"); }
    if root.join("src-tauri").exists() { traits.push("tauri"); }
    if root.join("vite.config.ts").exists() || root.join("vite.config.js").exists() { traits.push("vite"); }
    if root.join("next.config.js").exists() || root.join("next.config.ts").exists() { traits.push("nextjs"); }
    if root.join("apps").exists() { traits.push("monorepo-apps"); }
    if root.join("packages").exists() { traits.push("monorepo-packages"); }
    if root.join("src").exists() { traits.push("src"); }
    if root.join("README.md").exists() { traits.push("readme"); }

    if traits.is_empty() {
        "No cached summary available.".to_string()
    } else {
        format!("Detected {}", traits.join(", "))
    }
}

fn build_agent_profiles(agents: &Value) -> String {
    let Some(items) = agents.as_array() else {
        return "[]".to_string();
    };

    let profiles = items
        .iter()
        .map(|agent| {
            let id = agent.get("id").and_then(Value::as_str).unwrap_or_default();
            json!({
                "id": id,
                "display_name": agent.get("display_name").and_then(Value::as_str).unwrap_or(id),
                "enabled": agent.get("enabled").and_then(Value::as_i64).unwrap_or(0) == 1,
                "model": agent.get("model").and_then(Value::as_str),
                "strengths": non_empty_or_default(agent.get("strengths").and_then(Value::as_str), default_agent_strengths(id)),
                "weaknesses": non_empty_or_default(agent.get("weaknesses").and_then(Value::as_str), default_agent_weaknesses(id)),
                "best_for": non_empty_or_default(agent.get("best_for").and_then(Value::as_str), default_agent_best_for(id)),
                "reasoning_class": non_empty_or_default(agent.get("reasoning_class").and_then(Value::as_str), default_reasoning_class(id)),
                "speed_class": non_empty_or_default(agent.get("speed_class").and_then(Value::as_str), default_speed_class(id)),
                "edit_reliability": non_empty_or_default(agent.get("edit_reliability").and_then(Value::as_str), default_edit_reliability(id)),
            })
        })
        .collect::<Vec<_>>();

    serde_json::to_string_pretty(&profiles).unwrap_or_else(|_| "[]".to_string())
}

fn non_empty_or_default(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn default_agent_strengths(id: &str) -> &'static str {
    match id {
        "claude-code" => "large refactors, ambiguous tasks, repo navigation",
        "codex-cli" => "precise implementation, patching, code edits",
        "gemini-cli" => "fast scanning, broad exploration, quick iteration",
        _ => "general code execution",
    }
}

fn default_agent_weaknesses(id: &str) -> &'static str {
    match id {
        "claude-code" => "slower on narrow edits",
        "codex-cli" => "weaker on broad ambiguity",
        "gemini-cli" => "less reliable on exact multi-file edits",
        _ => "unknown",
    }
}

fn default_agent_best_for(id: &str) -> &'static str {
    match id {
        "claude-code" => "cross-file changes, messy codebases, planning-heavy tasks",
        "codex-cli" => "tight bugfixes, deterministic edits, implementation-heavy tickets",
        "gemini-cli" => "initial scanning, lightweight changes, exploration",
        _ => "general tasks",
    }
}

fn default_reasoning_class(id: &str) -> &'static str {
    match id {
        "claude-code" => "high",
        "codex-cli" => "high",
        "gemini-cli" => "medium",
        _ => "unknown",
    }
}

fn default_speed_class(id: &str) -> &'static str {
    match id {
        "claude-code" => "medium",
        "codex-cli" => "medium",
        "gemini-cli" => "high",
        _ => "unknown",
    }
}

fn default_edit_reliability(id: &str) -> &'static str {
    match id {
        "claude-code" => "high",
        "codex-cli" => "high",
        "gemini-cli" => "medium",
        _ => "unknown",
    }
}

async fn call_openai(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });

    // Some newer OpenAI models only accept the default temperature.
    if !model.starts_with("gpt-5") {
        body["temperature"] = json!(0.2);
    }

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("OpenAI request failed: {err}"))?;

    let status = response.status();
    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("OpenAI response parse failed: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "OpenAI error: {}",
            json.get("error")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    json.get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .ok_or_else(|| "OpenAI response missing message content".to_string())
}

async fn call_anthropic(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": model,
            "max_tokens": 1024,
            "temperature": 0.2,
            "messages": [
                { "role": "user", "content": prompt }
            ]
        }))
        .send()
        .await
        .map_err(|err| format!("Anthropic request failed: {err}"))?;

    let status = response.status();
    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Anthropic response parse failed: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Anthropic error: {}",
            json.get("error")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    let content = json
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic response missing content".to_string())?;

    let text = content
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");

    if text.is_empty() {
        return Err("Anthropic response missing text content".to_string());
    }

    Ok(text)
}

async fn call_gemini(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );
    let response = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": prompt }]
                }
            ],
            "generationConfig": {
                "temperature": 0.2
            }
        }))
        .send()
        .await
        .map_err(|err| format!("Gemini request failed: {err}"))?;

    let status = response.status();
    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Gemini response parse failed: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Gemini error: {}",
            json.get("error")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    let text = json
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    if text.is_empty() {
        return Err("Gemini response missing text content".to_string());
    }

    Ok(text)
}

fn clean_json_response(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.starts_with("```") {
        let without_fence = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        return without_fence.to_string();
    }

    trimmed.to_string()
}

/// Extract JSON from CLI agent output. The agent may include preamble text
/// before the actual JSON array/object. Find the first `[` or `{` and the
/// matching closing bracket.
fn extract_json_from_output(raw: &str) -> String {
    let cleaned = clean_json_response(raw);

    // Try to find a JSON array first (most common for work items)
    if let Some(start) = cleaned.find('[') {
        if let Some(end) = cleaned.rfind(']') {
            if end > start {
                return cleaned[start..=end].to_string();
            }
        }
    }

    // Fall back to JSON object
    if let Some(start) = cleaned.find('{') {
        if let Some(end) = cleaned.rfind('}') {
            if end > start {
                return cleaned[start..=end].to_string();
            }
        }
    }

    cleaned
}

// ─── CLI Agent Analysis ────────────────────────────────────────────────────────

fn build_analysis_prompt(objective: &str, repo_paths: &[String]) -> String {
    let repo_list = repo_paths
        .iter()
        .enumerate()
        .map(|(i, p)| format!("  {}. {}", i + 1, p))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"You are a technical project manager performing codebase analysis.

OBJECTIVE: {objective}

REPOSITORIES TO ANALYZE:
{repo_list}

INSTRUCTIONS:
1. Explore the repository structure, key files, and architecture
2. Understand what exists and what the objective requires
3. Break the objective into 3-6 independent, parallelizable work items
4. For each work item, identify which files/directories it will touch
5. Ensure work items do NOT overlap on the same files — this is critical for parallel execution
6. Write detailed execution context for each work item so a coding agent can start immediately

You are running in a non-interactive pipeline. Do not ask follow-up questions.
Do not offer to do more work. Return ONLY the final JSON and nothing else.

Return a JSON array of work items in this exact format:
[
  {{
    "title": "Short descriptive title",
    "description": "Detailed instructions for the coding agent. Include specific files to modify, what to change, and acceptance criteria.",
    "files": ["list", "of", "files/dirs", "this", "touches"],
    "depends_on": ["optional title of another work item this depends on"]
  }}
]

Return ONLY the JSON array. No markdown fences, no commentary, no follow-up questions."#,
        objective = objective.trim(),
        repo_list = repo_list,
    )
}

fn resolve_cli_agent() -> Vec<String> {
    if cfg!(target_os = "windows") {
        // On Windows, use cmd /C to run claude
        vec!["cmd".to_string(), "/C".to_string(), "claude".to_string()]
    } else {
        vec!["claude".to_string()]
    }
}

#[tauri::command]
pub async fn analyze_and_plan(
    app: tauri::AppHandle,
    objective: String,
    repo_paths: Vec<String>,
    max_turns: Option<u32>,
) -> Result<Vec<OrchestratorTicketSpec>, String> {
    if objective.trim().is_empty() {
        return Err("Objective is required".to_string());
    }
    if repo_paths.is_empty() {
        return Err("At least one repository path is required".to_string());
    }

    // Verify repo paths exist
    for path in &repo_paths {
        if !std::path::Path::new(path).exists() {
            return Err(format!("Repository path does not exist: {path}"));
        }
    }

    let prompt = build_analysis_prompt(&objective, &repo_paths);
    let turns = max_turns.unwrap_or(25);

    // Use the first repo as the working directory
    let cwd = &repo_paths[0];

    let _ = app.emit("analysis:status", json!({
        "status": "running",
        "message": "Analyzing codebase..."
    }));

    // Build the command: claude -p "prompt" --allowedTools "..." --output-format json --max-turns N
    let parts = resolve_cli_agent();
    let mut command = if parts[0] == "cmd" {
        let mut cmd = tokio::process::Command::new(&parts[0]);
        // Build the full claude command as a single string for cmd /C
        let claude_cmd = format!(
            "claude -p {} --allowedTools \"Read,Glob,Grep,Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*)\" --output-format json --max-turns {}",
            shell_escape(&prompt),
            turns,
        );
        cmd.arg("/C").arg(&claude_cmd);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new(&parts[0]);
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--allowedTools")
            .arg("Read,Glob,Grep,Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*)")
            .arg("--output-format")
            .arg("json")
            .arg("--max-turns")
            .arg(turns.to_string());
        cmd
    };

    command
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let _ = app.emit("analysis:status", json!({
        "status": "running",
        "message": "CLI agent is exploring the codebase..."
    }));

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to spawn CLI agent: {err}. Is 'claude' installed and in PATH?"))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("CLI agent process failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = app.emit("analysis:status", json!({
            "status": "error",
            "message": format!("CLI agent failed: {stderr}")
        }));
        return Err(format!("CLI agent exited with status {}: {stderr}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let _ = app.emit("analysis:status", json!({
        "status": "parsing",
        "message": "Parsing analysis results..."
    }));

    // Parse the JSON output — claude --output-format json wraps result in a JSON object
    let work_items = parse_analysis_output(&stdout, &repo_paths)?;

    let _ = app.emit("analysis:status", json!({
        "status": "done",
        "message": format!("Analysis complete: {} work items", work_items.len())
    }));

    Ok(work_items)
}

fn parse_analysis_output(raw: &str, repo_paths: &[String]) -> Result<Vec<OrchestratorTicketSpec>, String> {
    let cleaned = clean_json_response(raw);

    // claude --output-format json wraps the result like: {"type":"result","result":"..."}
    // Try to extract the inner result first
    let inner = if let Ok(wrapper) = serde_json::from_str::<Value>(&cleaned) {
        if let Some(result_str) = wrapper.get("result").and_then(Value::as_str) {
            result_str.to_string()
        } else {
            cleaned.clone()
        }
    } else {
        cleaned.clone()
    };

    let json_str = extract_json_from_output(&inner);

    // Try parsing as AnalysisWorkItem array
    let items: Vec<AnalysisWorkItem> = serde_json::from_str(&json_str)
        .map_err(|err| format!("Failed to parse analysis output as work items: {err}. Raw: {json_str}"))?;

    if items.is_empty() {
        return Err("CLI agent returned no work items".to_string());
    }

    // Convert AnalysisWorkItem -> OrchestratorTicketSpec
    let primary_repo = repo_paths.first().map(|s| s.as_str());
    let specs = items
        .into_iter()
        .map(|item| {
            let files_note = item.files
                .as_ref()
                .map(|files| format!("\n\nFiles: {}", files.join(", ")))
                .unwrap_or_default();

            OrchestratorTicketSpec {
                title: item.title,
                context: item.description.chars().take(200).collect(),
                execution_context: Some(format!("{}{}", item.description, files_note)),
                orchestrator_note: Some("Generated by CLI agent analysis".to_string()),
                repo_path: primary_repo.map(|s| s.to_string()),
                assigned_agent: None,
                depends_on_titles: item.depends_on,
                duplicate_of_ticket_id: None,
                duplicate_policy: None,
                intent_type: Some("create_ticket".to_string()),
            }
        })
        .collect();

    Ok(specs)
}

fn shell_escape(s: &str) -> String {
    // For Windows cmd /C, wrap in double quotes and escape inner double quotes
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}
