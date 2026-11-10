import { useCallback, useEffect, useRef, useState } from 'react';
import { listSkills, type SkillDoor, type StoredSkill } from '../api/skills.js';

/**
 * One door's list as the page knows it. `error` is a failed or malformed read: it is never an empty
 * list, so a section says what went wrong instead of "No skills yet".
 */
export type SkillList =
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'ok'; skills: StoredSkill[] };

const DOORS: readonly SkillDoor[] = ['workspace', 'org'];

/**
 * The My workspace and Organization lists, read on mount and again after each write. A re-read keeps the
 * rows on screen until the answer lands, so a toggle never flashes the table away; a failed re-read
 * replaces them with its error rather than leaving a list the board no longer vouches for.
 */
export function useSkillLists() {
    const [lists, setLists] = useState<Record<SkillDoor, SkillList>>({
        workspace: { status: 'loading' },
        org: { status: 'loading' },
    });
    const alive = useRef(true);

    const reload = useCallback(async (doors: readonly SkillDoor[]) => {
        await Promise.all(
            doors.map(async (door) => {
                const result = await listSkills(door);
                if (!alive.current) return;
                const next: SkillList = result.ok
                    ? { status: 'ok', skills: result.skills }
                    : { status: 'error', error: result.error };
                setLists((prev) => ({ ...prev, [door]: next }));
            })
        );
    }, []);

    useEffect(() => {
        alive.current = true;
        void reload(DOORS);
        return () => {
            alive.current = false;
        };
    }, [reload]);

    return { lists, reload };
}
