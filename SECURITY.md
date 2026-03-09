# Security

## API Key Storage

Mozzie stores orchestrator API keys (OpenAI, Anthropic, Gemini) in the browser's `localStorage` within the Tauri webview. These keys never leave your machine — they are sent directly from the Rust backend to the respective provider APIs over HTTPS.

**Why localStorage instead of OS keychain?**
Mozzie is a local-first developer tool. The Tauri webview is sandboxed and not exposed to the internet, so the XSS risk that makes localStorage dangerous in web apps does not apply here. If you prefer OS-level credential storage, contributions are welcome — see `tauri-plugin-keyring`.

## Content Security Policy

The Tauri CSP is currently set to `null` (disabled). This is intentional: Mozzie needs to connect to arbitrary ACP agent endpoints and LLM provider APIs that the user configures at runtime. A restrictive CSP would break these connections.

## Agent Execution

Mozzie launches AI coding agents (Claude Code, Gemini CLI, etc.) as child processes with access to your filesystem within the configured repository. Agents operate in isolated git worktrees and their changes go through a review step before merging.

## Reporting Vulnerabilities

If you discover a security issue, please open a GitHub issue or contact the maintainers directly. We take security seriously and will respond promptly.
