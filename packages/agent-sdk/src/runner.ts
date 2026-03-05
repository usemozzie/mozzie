import type { AgentRunner, AgentCapability } from './types.js';

/** Minimal config needed to instantiate an AcpAgentRunner. */
export interface RunnerConfig {
  id: string;
  displayName: string;
  acpUrl: string;
  apiKeyRef?: string;
  model?: string;
}

/**
 * ACP-based agent runner.
 * The actual HTTP/SSE streaming is handled by the Rust `launch_agent` command.
 * This class exists as a thin typed wrapper for frontend code that needs the
 * runner abstraction (e.g. the settings panel listing).
 */
export class AcpAgentRunner implements AgentRunner {
  readonly id: string;
  readonly displayName: string;
  readonly acpUrl: string;

  constructor(config: RunnerConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.acpUrl = config.acpUrl;
  }

  getCapabilities(): AgentCapability[] {
    return ['execute-code', 'review-code', 'chat'];
  }
}
