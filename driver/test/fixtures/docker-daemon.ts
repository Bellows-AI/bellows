/**
 * The docker twin of the kubernetes fake API server (`k8s-apiserver.ts`): a router over argv whose
 * unscripted calls reject, so a test that passes is one whose every daemon call was accounted for.
 */
import type { ExecDocker } from '../../src/docker-runner-support.js';

/**
 * A test's routes for one daemon call: an answer, an Error the call rejects with, or `undefined`
 * for a call the test did not script.
 */
export type DockerSpecial = (args: readonly string[]) => { stdout: string; stderr?: string } | Error | undefined;

/** A daemon that answers from `special`, records every call, and rejects (recording it) any call `special` leaves. */
export function routedDocker(special: DockerSpecial): { exec: ExecDocker; calls: string[][]; unrouted: string[][] } {
    const calls: string[][] = [];
    const unrouted: string[][] = [];
    const exec: ExecDocker = async (args) => {
        calls.push([...args]);
        const answer = special(args);
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return answer;
        unrouted.push([...args]);
        throw new Error(`the daemon fake has no answer for docker ${args.join(' ')}`);
    };
    return { exec, calls, unrouted };
}
