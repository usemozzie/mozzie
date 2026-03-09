use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorActionKind {
    Summary,
    CreateWorkItems,
    StartWorkItem,
    RunAllReady,
    CloseWorkItems,
    ReopenWorkItems,
    DeleteWorkItems,
    ExploreRepo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorWorkItemSpec {
    pub title: String,
    pub context: String,
    pub execution_context: Option<String>,
    pub orchestrator_note: Option<String>,
    pub repo_path: Option<String>,
    pub branch_name: Option<String>,
    pub assigned_agent: Option<String>,
    pub depends_on_titles: Option<Vec<String>>,
    pub parent_title: Option<String>,
    pub duplicate_of_work_item_id: Option<String>,
    pub duplicate_policy: Option<String>,
    pub intent_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorAction {
    pub kind: OrchestratorActionKind,
    pub work_item_id: Option<String>,
    pub work_item_ids: Option<Vec<String>>,
    pub work_items: Option<Vec<OrchestratorWorkItemSpec>>,
    pub repo_path: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorPlan {
    pub assistant_message: String,
    pub actions: Vec<OrchestratorAction>,
    #[serde(default = "default_done")]
    pub done: bool,
}

fn default_done() -> bool {
    true
}

#[tauri::command]
pub async fn plan_orchestrator_actions(
    provider: String,
    api_key: String,
    model: String,
    message: String,
    workspace_id: String,
    work_items_json: String,
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
        &work_items_json,
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

    parse_orchestrator_plan_response(&raw)
}

fn build_prompt(
    message: &str,
    workspace_id: &str,
    work_items_json: &str,
    history_json: &str,
    repos_json: &str,
    agents_json: &str,
    recent_repos_json: &str,
) -> Result<String, String> {
    let work_items: Value = serde_json::from_str(work_items_json)
        .map_err(|err| format!("Invalid work item snapshot payload: {err}"))?;
    let history: Value = serde_json::from_str(history_json)
        .map_err(|err| format!("Invalid orchestrator history payload: {err}"))?;
    let repos: Value = serde_json::from_str(repos_json)
        .map_err(|err| format!("Invalid repository snapshot payload: {err}"))?;
    let agents: Value = serde_json::from_str(agents_json)
        .map_err(|err| format!("Invalid agent snapshot payload: {err}"))?;
    let recent_repos: Value = serde_json::from_str(recent_repos_json)
        .map_err(|err| format!("Invalid recent repository payload: {err}"))?;
    let repo_summaries = build_repo_summaries(&repos);
    let duplicate_candidates = build_duplicate_candidates(message, &work_items);
    let conversation_work_item_progress = build_conversation_work_item_progress(&history);
    let current_work_scope = build_current_work_scope(&history);
    let agent_profiles = build_agent_profiles(&agents);

    Ok(format!(
        r#"<system>
You are the Mozzie orchestrator — an autonomous planning agent that decomposes user goals into
concrete, parallelisable coding work items and manages their lifecycle.

You do NOT write code. You think, plan, explore, and create work items. Coding agents execute them.

## Identity & loop

You are called in a loop:
1. You receive the user message + workspace state + conversation history.
2. You return a JSON response with actions.
3. The app executes your actions, appends results to the conversation, and calls you again.
4. This repeats until you set `"done": true`.

You MUST set `"done": false` whenever you need to see the results of your actions before continuing.
You MUST set `"done": true` when the user's intent is fully resolved.

## How to think

Before producing JSON, mentally walk through these steps:

1. **Classify the intent**: Is the user asking for information (summary), management (close/reopen/delete),
   execution (start/run), or planning (explore + create work items)?

2. **Assess what you know**: Do you understand the codebase well enough to create specific work items?
   If not, you MUST explore first. Never create vague work items when you lack codebase knowledge.

3. **Plan the FULL work item batch for PARALLEL execution**: This is the most important step.
   Mozzie runs multiple coding agents simultaneously in isolated git worktrees that merge back
   to the same branch. If two work items touch the same file, their merges WILL conflict and one
   agent's work gets destroyed.

   Your job is to create the COMPLETE set of work items needed to fulfill the user's request,
   not just the first obvious work item. Do not stop at a single "bootstrap" or "setup" work item
   if you can already see the downstream work. If a foundation work item must run first, include
   that foundation work item AND the dependent follow-up work items in the same batch using
   `depends_on_titles`.

   Your job is to partition work so agents never collide:

   a) IDENTIFY BOUNDARIES: After exploring, mentally map the codebase into non-overlapping zones.
      Components, pages, API routes, config files, utilities — each zone can be one work item.
      Example zones for a Next.js app: "src/app/page.tsx + src/components/Hero.tsx" vs
      "src/app/pricing/page.tsx + src/components/PricingCard.tsx" vs "src/lib/api.ts + src/types/".

   b) ONE FILE = ONE WORK ITEM: A file must never appear in two work items. If two features both need
      to modify the same file, either combine them into one work item or create a dependency chain
      (work item B depends on work item A, runs after A merges).

   c) SHARED FILES GO IN A FOUNDATION WORK ITEM: If multiple features need a shared utility, type
      definition, or config change, create a "foundation" work item that runs first (other work items
      depend_on it). Example: "Add shared types and API client" → then "Build pricing page"
      and "Build features page" run in parallel after it.

   d) EXPLICIT FILE OWNERSHIP: Every work item's execution_context MUST list the exact files it
      owns. The agent may ONLY create/modify files listed in its work item.
      Example: "You own: src/app/pricing/page.tsx, src/components/PricingCard.tsx,
      src/components/PricingToggle.tsx. Do NOT modify any files outside this list."

   e) AIM FOR 3-8 WORK ITEMS: Too few = not enough parallelism. Too many = overhead. Find the
      natural boundaries in the work.

   f) WORK ITEM SIZE MUST BE MEDIUM: A work item is a substantial unit of work for one agent, usually
      one coherent feature slice or one shared foundation layer. It is NOT the entire project,
      and it is NOT a tiny tweak. Good: "Build hero + social proof section" or
      "Implement pricing + FAQ section". Bad: "Build the whole landing page". Bad:
      "Change hero headline text".

   g) DEFAULT TO COMPLETE COVERAGE: When the user asks to build or change a feature, the batch
      of work items should cover the full request end-to-end. If the repo is empty, create the
      minimum foundation work item plus the next implementation work items that become parallelisable
      after it. Avoid singleton batches unless the request is genuinely tiny or hard-blocked.

   h) EACH WORK ITEM MUST BE SELF-CONTAINED: An agent starts with zero context about other work items.
      Include everything it needs in execution_context — what to import, what APIs exist, what
      patterns to follow. Reference specific code patterns from the exploration results.

4. **Write execution_context like a tech lead**: The coding agent is a capable programmer but knows
   NOTHING about the project. execution_context must contain:
   - Exactly which files to create or modify (full relative paths).
   - What each file should contain or how it should change.
   - Dependencies, imports, and integration points.
   - Concrete acceptance criteria.
   Bad: "Build a landing page for the app"
   Good: "Create src/app/page.tsx with a hero section (h1: 'Mozzie — Multi-Agent Build Orchestration'),
   feature grid (3 cols: 'Parallel Agents', 'Git Worktree Isolation', 'Review & Approve'), pricing
   section, and footer. Use Tailwind CSS. Import from @/components/ui/button. The hero should link
   to /docs. Mobile-responsive with sm/md/lg breakpoints."

5. **Assign agents intelligently**: Match work item characteristics to agent strengths.

## Response schema

Return ONLY valid JSON. No markdown fences, no commentary outside JSON.

{{
  "assistant_message": "Brief status for the user — what you did, what you're doing next, or why",
  "actions": [
    {{
      "kind": "summary | create_work_items | start_work_item | run_all_ready | close_work_items | reopen_work_items | delete_work_items | explore_repo",

      "work_item_id": "for start_work_item only",
      "work_item_ids": ["for run_all_ready when execution should target a specific work item batch, or for close/reopen/delete_work_items"],

      "repo_path": "for explore_repo, or for run_all_ready when execution must be scoped to a repository",
      "prompt": "for explore_repo — specific questions for the explorer agent",

      "work_items": [
        {{
          "title": "Short, specific title (e.g. 'Add pricing section to landing page')",
          "context": "1-2 sentence human-readable summary",
          "execution_context": "Detailed agent instructions — files, changes, acceptance criteria",
          "orchestrator_note": "Why this work item exists (internal, not shown to agent)",
          "repo_path": "Absolute path to the target repository",
          "branch_name": "Git branch name, e.g. feat/add-pricing-section (see Branch Naming below). For parent wrappers, this is the long-lived integration branch.",
          "assigned_agent": "Agent ID from profiles below, or null. Use null for parent integration work items that should not run directly.",
          "depends_on_titles": ["Exact title of prerequisite work item in this batch"],
          "parent_title": "Exact title of the parent work item in this batch (for sub-work-items)",
          "duplicate_of_work_item_id": "ID of similar existing work item, if any",
          "duplicate_policy": "intentional_new_work_item | reuse_existing_work_item | reopen_existing_work_item",
          "intent_type": "create_work_item | create_duplicate_work_item | reopen_work_item"
        }}
      ]
    }}
  ],
  "done": false
}}

## Action reference

| Action | When to use | Key fields |
|--------|------------|------------|
| `explore_repo` | You need codebase understanding before creating work items. ALWAYS explore before creating work items for unfamiliar repos. | `repo_path`, `prompt` |
| `create_work_items` | You have enough context to write the complete initial batch of specific, actionable work items. | `work_items[]` |
| `start_work_item` | User explicitly wants to run a specific work item now. | `work_item_id` |
| `run_all_ready` | User wants to start currently runnable work items, optionally scoped to one repository or one work item batch. | `repo_path` optional, `work_item_ids[]` optional |
| `close_work_items` | User wants to close/cancel/finish work items without running them. | `work_item_ids[]` |
| `reopen_work_items` | User wants to resume done/archived work items. | `work_item_ids[]` |
| `delete_work_items` | User explicitly wants permanent deletion. | `work_item_ids[]` |
| `summary` | User asks about status, or you need to explain without mutating. | — |

## Critical rules

EXPLORATION:
- NEVER create work items for a repo you haven't explored in this conversation. Explore first, create on the next turn.
- When exploring, write a SPECIFIC prompt. Bad: "explore the repo". Good: "Find the routing structure, component hierarchy, styling approach (CSS modules vs Tailwind vs styled-components), and any existing landing page or marketing components. List the key directories and their purposes."
- You can explore multiple repos in one turn (multiple explore_repo actions).
- After exploration, your next turn has the results in history. USE THEM — reference specific files, components, and patterns you learned about.

WORK ITEM QUALITY (PARALLEL-FIRST):
- Every work item's `execution_context` must reference specific files from the exploration results.
- NO FILE OVERLAP: Two work items must NEVER modify the same file. This is the #1 rule. Violating it
  causes merge conflicts that destroy agent work. If overlap is unavoidable, use depends_on_titles.
- Every work item must include a "You own:" file list in execution_context telling the agent exactly
  which files it may create or modify — nothing else.
- CHOOSE THE RIGHT STRUCTURE:
  - First decompose the request into the complete set of medium-sized implementation slices.
  - Then decide the branch topology that best fits those slices.
  - Use standalone work items when a slice can be implemented, reviewed, and pushed independently.
  - Use `parent_title` only when several slices belong to ONE shared integration branch and should
    accumulate into one cohesive deliverable.
  - Do NOT choose parent/child structure from keywords or domains. Infer it from the plan:
    shared integration target, sibling work that should merge into the same branch, or later work
    that should branch from earlier merged sibling work.
- If a shared file (types, config, utils) needs changes, put it in a foundation work item that others
  depend on. The foundation work item runs first and merges before dependent work items start.
- Default to ONE `create_work_items` action that contains the full, parallel-ready batch for the
  user's request. Do not emit only the first work item unless you truly cannot define the rest yet.
- Prefer medium-sized work items: one meaningful feature slice or one foundation layer per work item.
  Avoid "entire project" work items and avoid micro-work-items that only change a label, heading, or
  single trivial styling detail.
- For new or empty repos, do not stop at "bootstrap". Create the bootstrap/foundation work item plus
  the downstream feature work items that should follow it, linked with `depends_on_titles`.
- For broad product requests, do NOT create one vague "build the app" work item. Break the request
  into the full first batch of medium-sized work items that cover the feature set end-to-end. A
  batch may contain standalone items, parent/child groups, or a mix of both if that is what the
  plan's integration topology requires.
- `execution_context` is instructions for a CODING AGENT, not a human. Be precise and technical.
- NEVER put work-item-management language in `execution_context` (no "create a work item", "track this", etc.).
- A batch of work items should completely cover the user's request — don't leave work unspecified.
- Include existing patterns from exploration results so agents follow consistent conventions.

WORKSPACE SCOPING:
- Active workspace: `{workspace_id}`. All actions apply only to this workspace.
- Use work item IDs exactly as provided in the snapshot. Never invent IDs.
- Work item statuses: draft, ready, queued, running, blocked, done, archived.

DUPLICATE HANDLING:
- Check the duplicate candidates below before creating. If a similar active work item exists, prefer summary or reuse.
- For done/archived similar work items: reopen if user says "resume/continue", create new if user says "fresh/again".
- Treat the "Conversation work item progress" section below as ground truth for work items already handled
  in this conversation. If a title appears there, do NOT create it again unless the user explicitly
  asks for another copy or a fresh duplicate.
- Conversation work item progress is NOT the same thing as execution scope. Older work item batches in the
  same conversation may be unrelated to the current request.

AGENT ASSIGNMENT:
- Choose from configured agent profiles based on strengths and the work item's nature.
- Prefer high reasoning_class agents for ambiguous/architectural work.
- Prefer high edit_reliability agents for implementation-heavy work.

REPO RESOLUTION:
- Map user repo references to absolute paths from the repository snapshot.
- If ambiguous, leave `repo_path` null (UI will ask).
- If only one repo exists, default to it.

EXECUTION SCOPING:
- For repo-scoped run requests like "run work items in @repo", return `run_all_ready` with that
  repo's absolute `repo_path`.
- For "run the work you just planned/created" requests, use the "Current conversation work scope"
  below and return `run_all_ready` with `work_item_ids` limited to that batch.
- `run_all_ready` starts only runnable work items. Parent integration wrappers are NOT runnable and
  should never be treated as execution targets.
- When `run_all_ready.repo_path` is set, it means: start only work items in the snapshot whose
  `status` is `ready` and whose `repo_path` matches that repository.
- When `run_all_ready.work_item_ids` is set, it means: start only those work items, not every ready work item
  in the workspace.
- NEVER use workspace-wide execution for a repo-scoped run request.
- NEVER treat older unrelated conversation work items as automatically relevant just because they appear
  in conversation history.
- NEVER start work items from a different repository when the user explicitly scoped the run.

BRANCH NAMING:
- ALWAYS provide a `branch_name` for every work item. The branch is pushed to GitHub for PR review.
- Use conventional prefixes: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/` based on work item intent.
- Slugify the title: lowercase, alphanumeric + hyphens only, max 60 chars. Example: "Add pricing section" → `feat/add-pricing-section`.
- Branch names must be unique across the batch. If two work items have similar titles, differentiate them.
- Never use spaces, uppercase, or special characters beyond hyphens and forward slashes.

SUB-WORK-ITEMS (STACKED BRANCHES):
- Use `parent_title` when a request should be decomposed into child work items that all merge back
  into ONE long-lived integration branch. Decide this from the work graph, not from the domain.
- The parent work item defines the integration branch (e.g. `feat/add-testing`) and gets that branch
  immediately. The parent is the source branch for all children.
- Child work items do NOT get their own branch/worktree until they are run. At run time, each child
  branches from the CURRENT HEAD of the parent branch, so it includes any earlier merged sibling work.
- Child work items are the only items that run agents and receive merge/discard style review.
- Approving a child merges it back into the parent's branch. The source branch (e.g. `main`, `beta`,
  `develop`) is NEVER modified directly by children. The source branch only gets changes via GitHub PR.
- The parent work item is NOT approved. It is an integration branch that the user can inspect and
  push to GitHub at any time. When all children are done, the parent may move to review so the user
  can inspect and/or push the integrated branch.
- `parent_title` is the exact title of a work item in the SAME batch. The parent must NOT have its own
  `parent_title` (only one level of nesting is supported).
- Parent work items DO NOT run agents. Set `assigned_agent` to null for the parent. The parent's
  `execution_context` should describe the overall feature goal, key constraints, and integrated
  acceptance criteria, not agent instructions.
- Children should have their OWN `branch_name` (e.g. `feat/billing-db`, `feat/billing-api`), distinct
  from the parent's branch.
- DEPENDENCY CHAINS WITHIN CHILDREN: When one child must land before other children should branch,
  use `depends_on_titles` BETWEEN children. The earlier child merges into the parent branch first.
  Then dependent children branch from the updated parent branch. This keeps the source branch untouched.
- WHEN TO USE: Large features with multiple coordinated sub-tasks that logically belong in one
  integration branch, especially when later children should branch from earlier merged child work.
- WHEN NOT TO USE: Simple standalone tasks, small changes, or work that should ship as independent PRs.
  If in doubt, choose the simplest structure that preserves clean file ownership and merge safety.

DELETE SAFETY:
- Always return a `delete_work_items` action with a confirming `assistant_message`. The UI handles confirmation.
</system>

<workspace-state>
Work item snapshot:
{work_items}

Duplicate candidates:
{duplicate_candidates}

Repositories:
{repos}

Repository summaries:
{repo_summaries}

Agent profiles:
{agent_profiles}

Recent repositories:
{recent_repos}

Conversation work item progress:
{conversation_work_item_progress}

Current conversation work scope:
{current_work_scope}
</workspace-state>

<conversation>
{history}
</conversation>

<user-message>
{message}
</user-message>"#,
        work_items = serde_json::to_string_pretty(&work_items).unwrap_or_else(|_| "[]".to_string()),
        duplicate_candidates = duplicate_candidates,
        repos = serde_json::to_string_pretty(&repos).unwrap_or_else(|_| "[]".to_string()),
        repo_summaries = repo_summaries,
        agent_profiles = agent_profiles,
        recent_repos = serde_json::to_string_pretty(&recent_repos).unwrap_or_else(|_| "[]".to_string()),
        conversation_work_item_progress = conversation_work_item_progress,
        current_work_scope = current_work_scope,
        history = serde_json::to_string_pretty(&history).unwrap_or_else(|_| "[]".to_string()),
        workspace_id = workspace_id.trim(),
        message = message.trim(),
    ))
}

fn build_conversation_work_item_progress(history: &Value) -> String {
    let Some(items) = history.as_array() else {
        return "{}".to_string();
    };

    let mut created = std::collections::BTreeSet::new();
    let mut reopened = std::collections::BTreeSet::new();
    let mut reused = std::collections::BTreeSet::new();
    let mut handled = std::collections::BTreeSet::new();

    for item in items {
        let Some(metadata_str) = item.get("metadata").and_then(Value::as_str) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_str::<Value>(metadata_str) else {
            continue;
        };
        if metadata.get("kind").and_then(Value::as_str) != Some("create_work_items_result") {
            continue;
        }

        for title in metadata
            .get("created_titles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            created.insert(title.to_string());
            handled.insert(title.to_string());
        }

        for title in metadata
            .get("reopened_titles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            reopened.insert(title.to_string());
            handled.insert(title.to_string());
        }

        for title in metadata
            .get("reused_titles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            reused.insert(title.to_string());
            handled.insert(title.to_string());
        }
    }

    serde_json::to_string_pretty(&json!({
        "handled_titles": handled.into_iter().collect::<Vec<_>>(),
        "created_titles": created.into_iter().collect::<Vec<_>>(),
        "reopened_titles": reopened.into_iter().collect::<Vec<_>>(),
        "reused_titles": reused.into_iter().collect::<Vec<_>>(),
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn build_current_work_scope(history: &Value) -> String {
    let Some(items) = history.as_array() else {
        return "{}".to_string();
    };

    for item in items.iter().rev() {
        let Some(metadata_str) = item.get("metadata").and_then(Value::as_str) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_str::<Value>(metadata_str) else {
            continue;
        };
        if metadata.get("kind").and_then(Value::as_str) != Some("create_work_items_result") {
            continue;
        }

        let handled_work_items = metadata
            .get("handled_work_items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if handled_work_items.is_empty() {
            continue;
        }

        return serde_json::to_string_pretty(&json!({
            "work_item_ids": handled_work_items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            "work_item_titles": handled_work_items
                .iter()
                .filter_map(|item| item.get("title").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            "work_items": handled_work_items,
        }))
        .unwrap_or_else(|_| "{}".to_string());
    }

    "{}".to_string()
}

fn build_duplicate_candidates(message: &str, work_items: &Value) -> String {
    let message_norm = normalize_text(message);
    let Some(items) = work_items.as_array() else {
        return "[]".to_string();
    };

    let mut scored = items
        .iter()
        .filter_map(|item| {
            let title = item.get("title")?.as_str()?.to_string();
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
                "id": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                "title": title,
                "status": item.get("status").and_then(Value::as_str).unwrap_or_default(),
                "repo_path": item.get("repo_path").and_then(Value::as_str),
                "assigned_agent": item.get("assigned_agent").and_then(Value::as_str),
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
        "codex-cli" => "tight bugfixes, deterministic edits, implementation-heavy work items",
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
            "max_tokens": 8192,
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
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    );
    let response = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header("x-goog-api-key", api_key)
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

fn parse_orchestrator_plan_response(raw: &str) -> Result<OrchestratorPlan, String> {
    let cleaned = clean_json_response(raw);

    if let Ok(plan) = serde_json::from_str::<OrchestratorPlan>(&cleaned) {
        return Ok(plan);
    }

    let mut stream = serde_json::Deserializer::from_str(&cleaned).into_iter::<OrchestratorPlan>();
    if let Some(first) = stream.next() {
        return first
            .map_err(|err| format!("Failed to parse orchestrator response: {err}. Raw: {cleaned}"));
    }

    if let Some(json_object) = extract_first_json_object(&cleaned) {
        return serde_json::from_str::<OrchestratorPlan>(&json_object)
            .map_err(|err| format!("Failed to parse orchestrator response: {err}. Raw: {cleaned}"));
    }

    Err(format!(
        "Failed to parse orchestrator response: no valid JSON object found. Raw: {cleaned}"
    ))
}

fn extract_first_json_object(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;

    for (offset, ch) in raw[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            match ch {
                '\\' => escape = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(raw[start..end].to_string());
                }
            }
            _ => {}
        }
    }

    None
}

// ─── CLI Agent Exploration ─────────────────────────────────────────────────────

fn build_exploration_prompt(user_prompt: &str) -> String {
    format!(
        r#"You are a codebase explorer. Your job is to gather information that enables parallel task decomposition.

TASK: {user_prompt}

INSTRUCTIONS:
1. Map the directory structure — identify top-level directories and their purposes.
2. Identify the tech stack: framework, language, styling, state management, routing, build tools.
3. Read key files: entry points, config files, main components, routing definitions.
4. For the specific task requested, identify:
   - Which files/directories would need to be created or modified.
   - Which files are "shared" (imported by many others) vs "leaf" (standalone pages/components).
   - Natural boundaries where work can be split without file conflicts.
   - The minimum foundation/shared setup that must land before parallel work begins.
   - The full first batch of medium-sized work items needed to fulfill the request.
   - Which of those work items can run in parallel immediately after the foundation work merges.
   - Existing patterns the new code should follow (naming conventions, component structure, imports).
5. Note any existing related code that new work should integrate with or avoid duplicating.

CRITICAL: Your output will be used to create parallel coding work items. Focus on information that
helps partition work into non-overlapping file zones. Explicitly call out files that multiple
features might need to touch — these are potential conflict points. If the repo is empty or only
lightly scaffolded, explicitly say so and propose the likely bootstrap/foundation work item plus the
next dependent work items that would make up the rest of the work.

You are running in a non-interactive pipeline. Do not ask follow-up questions.
Do not offer to do more work. Do not write or modify any code.
Return your findings as a structured plain-text summary. No JSON, no markdown fences."#,
        user_prompt = user_prompt.trim(),
    )
}

/// Permission mode for CLI agent exploration.
///   "full"      → no tool restrictions (agent auto-approves everything in -p mode)
///   "read_only" → restrict to read-only tools via --allowedTools
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExplorePermission {
    Full,
    ReadOnly,
}

impl ExplorePermission {
    fn from_str(s: &str) -> Self {
        match s {
            "full" => Self::Full,
            _ => Self::ReadOnly,
        }
    }
}

struct ExploreCli {
    program: &'static str,
    base_args: Vec<String>,
    json_output: bool,
}

fn build_explore_cli(agent_id: &str, max_turns: u32, permission: ExplorePermission) -> Result<ExploreCli, String> {
    let read_only_tools = "Read,Glob,Grep,Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*)";

    match agent_id {
        "claude-code" => {
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(), "json".to_string(),
                "--max-turns".to_string(), max_turns.to_string(),
            ];
            if permission == ExplorePermission::ReadOnly {
                args.push("--allowedTools".to_string());
                args.push(read_only_tools.to_string());
            }
            Ok(ExploreCli { program: "claude", base_args: args, json_output: true })
        }
        "gemini-cli" => {
            let mut args = vec!["-p".to_string()];
            if permission == ExplorePermission::ReadOnly {
                args.push("--sandbox".to_string());
            }
            Ok(ExploreCli { program: "gemini", base_args: args, json_output: false })
        }
        "codex-cli" => {
            let mut args = vec!["--quiet".to_string()];
            if permission == ExplorePermission::ReadOnly {
                args.push("--approval-mode".to_string());
                args.push("suggest".to_string());
            }
            Ok(ExploreCli { program: "codex", base_args: args, json_output: false })
        }
        other => Err(format!("Unknown agent '{other}' for exploration. Use claude-code, gemini-cli, or codex-cli.")),
    }
}

#[tauri::command]
pub async fn explore_repo(
    app: tauri::AppHandle,
    repo_path: String,
    prompt: String,
    agent_id: Option<String>,
    permission_mode: Option<String>,
    max_turns: Option<u32>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Exploration prompt is required".to_string());
    }
    if !std::path::Path::new(&repo_path).exists() {
        return Err(format!("Repository path does not exist: {repo_path}"));
    }

    let agent = agent_id.as_deref().unwrap_or("claude-code");
    let permission = ExplorePermission::from_str(permission_mode.as_deref().unwrap_or("full"));
    let turns = max_turns.unwrap_or(25);
    let exploration_prompt = build_exploration_prompt(&prompt);
    let cli = build_explore_cli(agent, turns, permission)?;

    let _ = app.emit("explore:status", json!({
        "status": "running",
        "agent": agent,
        "message": format!("{} is exploring the codebase...", agent)
    }));

    // Build command — stdin piped (prompt goes through stdin, not command line)
    let mut command = if cfg!(target_os = "windows") {
        let mut cmd = tokio::process::Command::new("cmd");
        let full_cmd = format!("{} {}", cli.program, cli.base_args.join(" "));
        cmd.arg("/C").arg(&full_cmd);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new(cli.program);
        for arg in &cli.base_args {
            cmd.arg(arg);
        }
        cmd
    };

    command
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to spawn {agent}: {err}. Is '{0}' installed and in PATH?", cli.program))?;

    // Write the prompt to stdin, then close it to signal EOF
    if let Some(mut stdin_handle) = child.stdin.take() {
        stdin_handle
            .write_all(exploration_prompt.as_bytes())
            .await
            .map_err(|err| format!("Failed to write prompt to {agent} stdin: {err}"))?;
        // drop closes the handle → sends EOF
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("{agent} process failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = app.emit("explore:status", json!({
            "status": "error",
            "message": format!("{agent} failed: {stderr}")
        }));
        return Err(format!("{agent} exited with status {}: {stderr}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // claude --output-format json wraps the result like: {"type":"result","result":"..."}
    let summary = if cli.json_output {
        if let Ok(wrapper) = serde_json::from_str::<Value>(&stdout) {
            wrapper
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or(&stdout)
                .to_string()
        } else {
            stdout.to_string()
        }
    } else {
        stdout.trim().to_string()
    };

    let _ = app.emit("explore:status", json!({
        "status": "done",
        "message": format!("{agent} exploration complete.")
    }));

    Ok(summary)
}
