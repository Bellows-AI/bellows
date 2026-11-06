import { type Post, contentRead } from './board-attachments.js';
import type { Board } from './board.js';

/**
 * The worker read of one pinned skill bundle (`POST /api/jobs/:id/skills/:versionId/content`), under the live
 * lease. Copied from `server/src/db/jobs/job-store-types.ts` rather than imported: this package depends on nothing.
 */

/** One skill of a claim's pin: the version this row was created with, as a ustar tar of its bundle. */
export interface ClaimSkill {
    name: string;
    source: 'org' | 'workspace';
    versionId: string;
    sha256: string;
}

/** The board no longer holds the bundle (410): never deliverable. */
export class SkillGone extends Error {}
/** The board's stored bundle fails its recorded sha256 (422 ARTIFACT_CORRUPT): never deliverable. */
export class SkillCorrupt extends Error {}

/**
 * What a claim carries of its pin (BEL-273): every enabled org and workspace skill the row was pinned to, each a version
 * the board serves under the lease; absent means none. A pin the claim carried but this client cannot read is
 * `skillPinUnreadable`, never an empty pin: the run is left to its lease instead of starting without its skills.
 */
export interface ClaimSkills {
    skillPin?: ClaimSkill[];
    skillPinUnreadable?: string;
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCES: readonly string[] = ['org', 'workspace'];

/**
 * A claim's `skillPin`: the list when every entry is well formed and no name repeats, `null` when it is absent
 * (a row with no pin), and a reason string when anything else arrives. A malformed pin is never read as "no
 * skills": the caller leaves the claim to its lease.
 */
export function skillPinOf(value: unknown): { pin: ClaimSkill[] } | { unreadable: string } {
    if (value === undefined || value === null) return { pin: [] };
    if (!Array.isArray(value)) return { unreadable: 'the claim carries a skillPin that is not a list' };
    const names = new Set<string>();
    for (const entry of value as unknown[]) {
        const e = entry as Partial<ClaimSkill> | null;
        if (
            typeof e !== 'object' ||
            e === null ||
            typeof e.name !== 'string' ||
            !SKILL_NAME.test(e.name) ||
            typeof e.source !== 'string' ||
            !SOURCES.includes(e.source) ||
            typeof e.versionId !== 'string' ||
            !VERSION_ID.test(e.versionId) ||
            typeof e.sha256 !== 'string' ||
            !SHA256.test(e.sha256)
        ) {
            return { unreadable: 'the claim carries a skillPin entry that is not a pinned skill version' };
        }
        if (names.has(e.name)) return { unreadable: `the claim's skillPin names ${e.name} twice` };
        names.add(e.name);
    }
    return { pin: value as ClaimSkill[] };
}

/** The claim's pin fields: the list, or the reason it could not be read. */
export const skillPinFields = (value: unknown): ClaimSkills => {
    const read = skillPinOf(value);
    return 'pin' in read ? { skillPin: read.pin } : { skillPinUnreadable: read.unreadable };
};

export function skillCalls(post: Post): Pick<Board, 'skillContent'> {
    return {
        skillContent: (job, versionId) =>
            contentRead(post, {
                job,
                path: `/api/jobs/${job.id}/skills/${versionId}/content`,
                what: `job ${job.id}: skill version ${versionId}`,
                errors: { gone: SkillGone, corrupt: SkillCorrupt },
            }),
    };
}
