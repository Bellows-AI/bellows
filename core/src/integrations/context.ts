/**
 * Shapes only. Nothing here confers trust: the server module that mints a trusted context owns the
 * constructor, and a value of these types built elsewhere is just data.
 */
export type Principal = { kind: 'user'; userId: string } | { kind: 'service'; serviceId: string };

/** Who is asking, as the board resolved it. */
export interface IntegrationCaller {
    principal: Principal;
    orgId: string;
}

/** Who started the work the call serves; a person, or the task they queued. */
export type Initiator = { kind: 'user'; userId: string } | { kind: 'job'; jobId: string; attempt: number };
