/**
 * What the board reads of a change request for an agent or a person (docs/gitlab.md): its diff, its notes, its pipeline.
 * Shared by the forge client that answers and the routes that serve it, so the wire shape has one spelling.
 */

export const CHANGE_REQUEST_PARTS = ['diff', 'notes', 'pipeline'] as const;
export type ChangeRequestPart = (typeof CHANGE_REQUEST_PARTS)[number];

export const isChangeRequestPart = (value: unknown): value is ChangeRequestPart =>
    (CHANGE_REQUEST_PARTS as readonly unknown[]).includes(value);

/** One changed file. `omitted` is the forge's own refusal to show a file's diff (too large): said, never silently empty. */
export interface ChangeRequestFile {
    oldPath: string;
    newPath: string;
    newFile: boolean;
    deletedFile: boolean;
    renamedFile: boolean;
    omitted: boolean;
    diff: string;
}

export interface ChangeRequestNote {
    id: number;
    author: string | null;
    body: string;
    createdAt: string;
    /** The forge's own bookkeeping entry ("added 1 commit"), not a person's comment. */
    system: boolean;
}

export interface ChangeRequestPipeline {
    status: string;
    url: string | null;
}

export interface ChangeRequestStatus {
    name: string;
    status: string;
    url: string | null;
}

export type ChangeRequestPartRead =
    | { part: 'diff'; files: ChangeRequestFile[] }
    | { part: 'notes'; notes: ChangeRequestNote[] }
    | { part: 'pipeline'; sha: string; pipeline: ChangeRequestPipeline | null; statuses: ChangeRequestStatus[] };

/** The forge answers no part of a change request here: a GitHub task keeps its own `gh`. No request was made. */
export class ChangeRequestReadUnsupportedError extends Error {
    constructor(forge: string) {
        super(`the board does not read ${forge} change requests`);
        this.name = 'ChangeRequestReadUnsupportedError';
    }
}
