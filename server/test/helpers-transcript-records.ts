/** Synthetic transcript records for the tool-event suites: no real repository, host or task id. */

export const SESSION = 'claude-session-1';
export const GATE = 'factory-gate test';

export const claudeCall = (id: string, command: string, timestamp?: string) =>
    JSON.stringify({
        type: 'assistant',
        sessionId: SESSION,
        ...(timestamp ? { timestamp } : {}),
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    });

export const claudeResult = (id: string, content: string, timestamp?: string, over: { isError?: boolean } = {}) =>
    JSON.stringify({
        type: 'user',
        sessionId: SESSION,
        ...(timestamp ? { timestamp } : {}),
        message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: over.isError === true }] },
    });

/** A record that is neither a call nor a result: a stretch of agent progress between the two. */
export const claudeProgress = (n: number) =>
    JSON.stringify({
        type: 'assistant',
        sessionId: SESSION,
        message: { content: [{ type: 'text', text: `step ${n}` }] },
    });

/** Lines as one chunk at `offset`, newline-terminated like the exporter's. */
export const chunkOf = (offset: number, lines: string[]) => ({ offset, text: `${lines.join('\n')}\n` });
