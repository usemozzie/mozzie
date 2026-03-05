export type AgentCapability = 'generate-plan' | 'execute-code' | 'review-code' | 'chat';

/** Configuration for starting an ACP run. */
export interface AcpRunConfig {
  ticketId: string;
  logId: string;
  workingDir: string;
  prompt: string;
  acpUrl: string;
  apiKey?: string;
  model?: string;
}

/** Minimal interface for an ACP-based agent runner. */
export interface AgentRunner {
  id: string;
  displayName: string;
  getCapabilities(): AgentCapability[];
}
