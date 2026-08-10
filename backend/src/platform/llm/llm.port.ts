/**
 * platform/llm — the language-model port. INTERFACE ONLY at this build step;
 * the real adapter lands with build step 7.
 *
 * This is the single external call that sits in a user request path, and it
 * is approved on that basis (00-ARCHITECTURE.md §0). It may see the student's
 * question and the retrieved passages. It must NEVER see a name, an email
 * address, a phone number, or an account identifier.
 */
export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
}

export interface LlmChunk {
  readonly text: string;
}

export interface LlmCompletion {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

export interface LlmProvider {
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}
