import type {Tool} from '@modelcontextprotocol/sdk/types.js'

/**
 * A tool call request from the model provider.
 */
export interface ProviderToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * The result of a single provider completion step.
 *
 * - If `toolCalls` is non-empty, the loop must dispatch them and feed results back.
 * - If `content` is set and `toolCalls` is empty, the loop is done.
 */
export interface ProviderStepResult {
  usage?: import('../usage.js').ModelUsage
  content: string | null
  toolCalls: ProviderToolCall[]
}

export interface ToolResult {
  toolCallId: string
  content: string
}

/**
 * A simulation provider that wraps a model API (OpenAI, future Anthropic, etc).
 *
 * Only OpenAI is implemented in this milestone.
 */
export interface SimulationProvider {
  /**
   * Start a NEW conversation: system prompt + first user message + tool definitions.
   */
  sendInitial(message: string, tools: Tool[]): Promise<ProviderStepResult>

  /**
   * Continue the conversation by feeding tool results back to the model.
   */
  sendToolResults(toolResults: ToolResult[]): Promise<ProviderStepResult>

  /**
   * Append another user turn to the EXISTING conversation (multi-turn).
   * Optional so simple/fake providers need not implement it; callers fall back to sendInitial.
   */
  sendUserMessage?(message: string): Promise<ProviderStepResult>

  /** Whether a conversation has been started (sendInitial called). */
  hasHistory?(): boolean
}
