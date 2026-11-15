import type { AuthState, MemoryAuthStore } from './helpers-auth-store.js';
import { nowIso } from './helpers-auth-store.js';

/**
 * The memory double's admin removals, the same outcomes as server/src/auth/member-removal.ts: the block row, the
 * membership's end (a session or token resolves through the membership, so both die with it), the last-admin
 * refusal, the restore, an account's blocks, and the invitation read's basis. An org row records no GitHub
 * account kind here.
 */
export function removalMethods(
    state: AuthState
): Pick<MemoryAuthStore, 'blockMember' | 'restoreMember' | 'listRemovedMembers' | 'blockedOrgs' | 'invitationBasis'> {
    const loginOf = (userId: string) => state.users.find((u) => u.id === userId)?.login ?? null;
    return {
        async blockMember(orgId, userId, removedBy) {
            const index = state.members.findIndex((m) => m.orgId === orgId && m.userId === userId);
            const target = state.members[index];
            if (!target) return 'missing';
            const admins = state.members.filter((m) => m.orgId === orgId && m.role === 'admin').length;
            if (target.role === 'admin' && admins <= 1) return 'last-admin';
            state.removals = state.removals.filter((r) => !(r.orgId === orgId && r.userId === userId));
            state.removals.push({ orgId, userId, removedBy, removedAt: nowIso() });
            state.members.splice(index, 1);
            return 'removed';
        },

        async restoreMember(orgId, userId) {
            const before = state.removals.length;
            state.removals = state.removals.filter((r) => !(r.orgId === orgId && r.userId === userId));
            return state.removals.length < before ? 'restored' : 'missing';
        },

        async listRemovedMembers(orgId) {
            return state.removals
                .filter((r) => r.orgId === orgId)
                .map((r) => ({
                    userId: r.userId,
                    githubLogin: loginOf(r.userId) ?? '',
                    removedAt: r.removedAt,
                    removedBy: loginOf(r.removedBy),
                }))
                .sort((a, b) => a.githubLogin.localeCompare(b.githubLogin));
        },

        async blockedOrgs(githubUserId) {
            const userIds = new Set(state.users.filter((u) => u.githubUserId === githubUserId).map((u) => u.id));
            return state.removals
                .filter((r) => userIds.has(r.userId))
                .map((r) => r.orgId)
                .sort();
        },

        async invitationBasis(orgId) {
            const org = state.orgs.get(orgId);
            if (!org) return null;
            const accounted = new Set([
                ...state.members.filter((m) => m.orgId === orgId).map((m) => m.userId),
                ...state.removals.filter((r) => r.orgId === orgId).map((r) => r.userId),
            ]);
            return {
                org: { id: org.id, name: org.name, accountType: null, accountId: null },
                githubUserIds: state.users.filter((u) => accounted.has(u.id)).map((u) => u.githubUserId),
            };
        },
    };
}
