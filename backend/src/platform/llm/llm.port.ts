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
  /**
   * CANCELLATION, and it is the whole of D-262 — step 1 of 3.
   *
   * `createGuardedLlm` enforces the §4 streaming budget and releases the
   * bulkhead slot in a `finally`, and NEITHER of those used to stop the work.
   * The caller stopped waiting; the vendor kept streaming and kept billing, the
   * socket and its reader lingered until GC, and — the part with no symptom —
   * **real concurrency exceeded the configured limit invisibly**, because the
   * slot was free while the work was not. A limiter of 20 that is actually
   * admitting 60 looks exactly like a limiter of 20 that is working.
   *
   * Optional because not every adapter can cancel: the deterministic fake has
   * nothing to abort. An adapter that CAN — anything built on `fetch` — must
   * forward it, and `guarded-llm` is what supplies it, so no call site has to
   * remember.
   */
  readonly signal?: AbortSignal;
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
