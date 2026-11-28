import type { Sql } from 'postgres';

/** The optional onboarding steps a member completes or skips (177_onboarding_provider_step.sql checks the same set). */
export const SETUP_STEPS = ['provider', 'tools'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_ACTIONS = ['done', 'skip'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** Where the member stands in onboarding: null `completedAt` means not finished yet; a step is in at most one list. */
export interface MembershipSetup {
    completedAt: string | null;
    done: SetupStep[];
    skipped: SetupStep[];
}

/** The three `org_membership` columns every caller read selects. */
export interface SetupRow {
    setup_completed_at: Date | null;
    setup_done: SetupStep[];
    setup_skipped: SetupStep[];
}

export const toSetup = (row: SetupRow): MembershipSetup => ({
    completedAt: row.setup_completed_at === null ? null : row.setup_completed_at.toISOString(),
    done: row.setup_done,
    skipped: row.setup_skipped,
});

export interface MembershipSetupStore {
    /** Marks one onboarding step done or skipped on the member's own row; it leaves the other list, never twice. */
    recordSetupStep(orgId: string, userId: string, step: SetupStep, action: SetupAction): Promise<void>;
    /** Stamps the member's setup completed; a second call keeps the first stamp. */
    completeSetup(orgId: string, userId: string): Promise<void>;
}

/**
 * Onboarding setup state on the member's own row. Each write is one statement: the row lock serializes two tabs, and
 * the array guards re-read the locked row, so a step lands in one list exactly once.
 */
export function buildSetupMethods(sql: Sql, gate: () => Promise<void>): MembershipSetupStore {
    return {
        async recordSetupStep(orgId, userId, step, action) {
            await gate();
            const [into, out] = action === 'done' ? ['setup_done', 'setup_skipped'] : ['setup_skipped', 'setup_done'];
            await sql`
                update org_membership set
                    ${sql(into)} = case when ${step} = any(${sql(into)}) then ${sql(into)}
                                        else array_append(${sql(into)}, ${step}::text) end,
                    ${sql(out)} = array_remove(${sql(out)}, ${step}::text)
                where org_id = ${orgId} and user_id = ${userId}
            `;
        },

        async completeSetup(orgId, userId) {
            await gate();
            await sql`
                update org_membership set setup_completed_at = now()
                where org_id = ${orgId} and user_id = ${userId} and setup_completed_at is null
            `;
        },
    };
}
