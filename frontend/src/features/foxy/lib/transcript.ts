import type { FoxyMessageDto } from '@/lib/api/generated/contracts/foxy.contract';
import type { FoxyStreamMessage } from '../hooks/use-foxy-stream';

/**
 * ===========================================================================
 * STORED HISTORY → THE SHAPE THE LIST RENDERS.
 *
 * The transcript and the live stream are two sources for one list, and the list
 * must not know that. So the stored form is converted to the streaming form
 * rather than the renderer being taught both — one presentational component,
 * one prop type, and a test can hand it an array without a network or a hook.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CONVERSION AND NOT A MERGE.
 *
 * The two lists are CONCATENATED, never merged, and nothing deduplicates them
 * — because nothing can. A user message has NO server id at all, ever, and
 * matching on text would collapse a student who asked the same question twice.
 *
 * What makes concatenation safe is that they cannot overlap: `useFoxyStream`
 * marks the transcript stale WITHOUT refetching it (`refetchType: 'none'`), so
 * a mounted screen's stored half never grows to include a turn the hook is
 * still holding. History is what existed when the screen opened; the hook owns
 * everything since; a reload re-reads the whole thing from the server.
 * ===========================================================================
 */
export function historyToMessages(
  messages: readonly FoxyMessageDto[],
): readonly FoxyStreamMessage[] {
  return messages.map((message) => ({
    // Prefixed, because the ids are React keys in a list that also holds live
    // messages keyed `local-N`, and the two counters know nothing about each
    // other. A collision would silently reuse a DOM node.
    localId: `stored-${message.id}`,
    serverId: message.id,
    role: message.role,
    text: message.text,
    citations: message.citations,
    abstained: message.abstained,
    status: 'complete',
    // A stored message was never truncated by THIS client. The cap in
    // `useFoxyStream` bounds a stream in flight; what the server saved is what
    // the server saved.
    truncated: false,
  }));
}
