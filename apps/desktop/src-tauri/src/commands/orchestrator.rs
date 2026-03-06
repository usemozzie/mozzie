use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorActionKind {
    Summary,
    CreateTickets,
    StartTicket,
    RunAllReady,
    DeleteTickets,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorTicketSpec {
    pub title: String,
    pub context: String,
    pub repo_path: Option<String>,
    pub assigned_agent: Option<String>,
    pub depends_on_titles: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorAction {
    pub kind: OrchestratorActionKind,
    pub ticket_id: Option<String>,
    pub ticket_ids: Option<Vec<String>>,
    pub tickets: Option<Vec<OrchestratorTicketSpec>>,
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
    tickets_json: String,
    history_json: String,
) -> Result<OrchestratorPlan, String> {
    if api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }

    if model.trim().is_empty() {
        return Err("Model is required".to_string());
    }

    let prompt = build_prompt(&message, &tickets_json, &history_json)?;
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

fn build_prompt(message: &str, tickets_json: &str, history_json: &str) -> Result<String, String> {
    let tickets: Value = serde_json::from_str(tickets_json)
        .map_err(|err| format!("Invalid ticket snapshot payload: {err}"))?;
    let history: Value = serde_json::from_str(history_json)
        .map_err(|err| format!("Invalid orchestrator history payload: {err}"))?;

    Ok(format!(
        r#"You are the Mozzie orchestrator.

You control tickets, not code. You decide actions, then the app executes them.

Return ONLY valid JSON. Do not wrap in markdown fences.

Schema:
{{
  "assistant_message": "short explanation for the user",
  "actions": [
    {{
      "kind": "summary" | "create_tickets" | "start_ticket" | "run_all_ready" | "delete_tickets",
      "ticket_id": "required only for start_ticket",
      "ticket_ids": ["required only for delete_tickets"],
      "tickets": [
        {{
          "title": "required for create_tickets",
          "context": "required for create_tickets",
          "repo_path": "optional absolute path or null",
          "assigned_agent": "optional or null",
          "depends_on_titles": ["optional array of ticket titles this ticket depends on"]
        }}
      ]
    }}
  ]
}}

Rules:
- Use ticket IDs exactly as provided in the ticket snapshot.
- For delete requests, do not assume immediate execution is safe. Return a delete_tickets action and a clear assistant_message; the UI will ask for confirmation.
- Prefer create_tickets when the user wants work split into independent runnable tickets.
- If the user is only asking for status or summary, return a summary action or no actions.
- Do not invent ticket IDs.
- Keep assistant_message concise.
- When creating multiple tickets where some depend on others, use depends_on_titles to reference prerequisite tickets by their exact title in the same batch. Dependencies are only set for Pro users.

Current ticket snapshot:
{tickets}

Recent orchestrator chat history:
{history}

User message:
{message}"#,
        tickets = serde_json::to_string_pretty(&tickets).unwrap_or_else(|_| "[]".to_string()),
        history = serde_json::to_string_pretty(&history).unwrap_or_else(|_| "[]".to_string()),
        message = message.trim(),
    ))
}

async fn call_openai(api_key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": model,
            "temperature": 0.2,
            "messages": [
                { "role": "user", "content": prompt }
            ]
        }))
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
