import { expect } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { DEFAULT_FILTERS, type UseTasks } from '../src/api/useTasks.js';

/** What a null metric leaks as when it reaches the markup as a value. */
export const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/** No placeholder in `text`; a failure names the token that leaked. */
export function expectNoPlaceholder(text: string | null | undefined): void {
    for (const token of FORBIDDEN) expect(text, token).not.toContain(token);
}

const BELLOWS = { id: 'bellows', name: 'Bellows AI' };

/** A signed-in GitHub member of Bellows AI; `user` overrides merge into the default user. */
export function memberSession(
    overrides: Partial<Omit<Session, 'user'>> & { user?: Partial<Session['user']> } = {}
): Session {
    const { user, ...rest } = overrides;
    return {
        authenticated: true,
        user: {
            id: '00000000-0000-4000-8000-000000000001',
            login: 'octocat',
            name: 'The Octocat',
            githubUserId: 4242,
            avatarUrl: null,
            ...user,
        },
        role: 'member',
        membership: { invitedAt: null, claimedAt: null },
        account: { createdAt: null, lastLoginAt: null },
        organization: BELLOWS,
        organizations: [BELLOWS],
        workspacePath: null,
        mode: 'github',
        ...rest,
    };
}

/** The shell's task poll before its first page lands: nothing loaded, every action a no-op. */
export function idleTasks(): UseTasks {
    return {
        navigation: null,
        items: null,
        nextCursor: null,
        initial: true,
        loadingMore: false,
        refreshing: false,
        error: null,
        refreshError: null,
        loadMoreError: null,
        filters: DEFAULT_FILTERS,
        retry: () => {},
        loadMore: () => {},
        refresh: () => {},
        actions: {
            queue: async () => ({ id: null, error: null }),
            followUp: async () => ({ id: null, error: null }),
            markDone: async () => null,
            stop: async () => null,
            remove: async () => null,
            answerQuestion: async () => ({ state: 'closed' }),
        },
    };
}
