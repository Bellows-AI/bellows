import { useEffect, useRef, useState } from 'react';
import type { SlashSkill } from '../slash-skills.js';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

export interface UseRepoSkills {
    status: 'idle' | 'loading' | 'ready' | 'error';
    skills: SlashSkill[];
    /** Why the repository's own skills are missing from `skills` (built-ins still listed), or null. */
    repoError: string | null;
    /** Skill names the repository holds that could not be read. */
    unreadable: string[];
    /** Why the listing failed outright; `skills` is empty then. */
    error: string | null;
}

interface SkillsBody {
    skills: SlashSkill[];
    repoError: string | null;
    unreadable: string[];
}

interface Held extends UseRepoSkills {
    key: string;
}

const idle = (key: string): Held => ({
    key,
    status: 'idle',
    skills: [],
    repoError: null,
    unreadable: [],
    error: null,
});

async function readSkills(repo: string, branch: string, signal: AbortSignal): Promise<SkillsBody> {
    const suffix = branch === '' ? '' : `?branch=${encodeURIComponent(branch)}`;
    const response = await fetch(`/api/repos/${repo}/skills${suffix}`, { signal });
    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        reportUnauthenticated();
        throw new Error('Your session expired');
    }
    if (!response.ok) throw new Error((await refusalOf(response, 'Could not list skills')).error);
    const body = (await response.json()) as Partial<SkillsBody>;
    if (!Array.isArray(body.skills)) throw new Error('Could not list skills (unexpected answer)');
    return { skills: body.skills, repoError: body.repoError ?? null, unreadable: body.unreadable ?? [] };
}

/**
 * The skills the prompt's `/` menu offers for a repository at a branch ('' = its default): the
 * built-ins and the repository's own. Reads only while `enabled`, once per (repo, branch); a
 * change of either aborts the read in flight and discards its answer.
 */
export function useRepoSkills(repo: string, branch: string, enabled: boolean): UseRepoSkills {
    const key = `${repo}\n${branch}`;
    const [held, setHeld] = useState<Held>(() => idle(key));
    // The (repo, branch) whose answer has landed: it is not read again while the menu opens and closes.
    const done = useRef<string | null>(null);

    useEffect(() => {
        if (!enabled || repo === '' || done.current === key) return;
        const controller = new AbortController();
        setHeld({ ...idle(key), status: 'loading' });
        readSkills(repo, branch, controller.signal).then(
            (body) => {
                if (controller.signal.aborted) return;
                done.current = key;
                setHeld({ ...idle(key), ...body, status: 'ready' });
            },
            (e: unknown) => {
                if (!controller.signal.aborted) setHeld({ ...idle(key), status: 'error', error: (e as Error).message });
            }
        );
        return () => controller.abort();
    }, [enabled, repo, branch, key]);

    return held.key === key ? held : idle(key);
}
