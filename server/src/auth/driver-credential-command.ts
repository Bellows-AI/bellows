import {
    DEFAULT_ROTATION_OVERLAP_SECONDS,
    type DriverCredentialStore,
    MAX_LABEL_LENGTH,
    MAX_ROTATION_OVERLAP_SECONDS,
} from './driver-credentials.js';

/**
 * The driver-credential maintenance command (`driver-credential-cli.ts`, docs/auth.md): list, issue, revoke and
 * rotate against the database, for a deployment with no operator account (self-hosted) — the operator API's
 * surface, answered by the same store. A minted token is printed once, on its own line; nothing else is ever a
 * token. Exit 0 done, 1 refused (an unknown id, an inactive credential, an unknown organization), 2 usage.
 */
export const DRIVER_CREDENTIAL_USAGE = [
    'usage: driver-credential-cli list',
    '       driver-credential-cli issue --label <label> (--pool | --org <orgId>...)',
    '       driver-credential-cli revoke <id>',
    `       driver-credential-cli rotate <id> [--overlap <seconds, 0..${MAX_ROTATION_OVERLAP_SECONDS}>]`,
].join('\n');

const USAGE_EXIT = 2;
const REFUSED_EXIT = 1;
const SECONDS = /^\d+$/;

export interface CommandIo {
    out: (line: string) => void;
    err: (line: string) => void;
}

type Parsed =
    | { kind: 'list' }
    | { kind: 'issue'; label: string; orgs: string[] | null }
    | { kind: 'revoke'; id: string }
    | { kind: 'rotate'; id: string; overlapSeconds: number }
    | { kind: 'usage'; message: string };

function parseIssue(rest: string[]): Parsed {
    let label = '';
    let pool = false;
    const orgs: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === '--pool') pool = true;
        else if (flag === '--label' && rest[i + 1] !== undefined) label = rest[++i]!;
        else if (flag === '--org' && rest[i + 1] !== undefined) orgs.push(rest[++i]!);
        else return { kind: 'usage', message: `unknown argument: ${flag}` };
    }
    if (label.trim() === '' || label.length > MAX_LABEL_LENGTH) {
        return { kind: 'usage', message: `--label is 1..${MAX_LABEL_LENGTH} characters` };
    }
    if (pool === orgs.length > 0) return { kind: 'usage', message: 'name exactly one scope: --pool or --org' };
    return { kind: 'issue', label: label.trim(), orgs: pool ? null : orgs };
}

function parseRotate(rest: string[]): Parsed {
    const [id, flag, value, ...extra] = rest;
    if (!id || extra.length > 0) return { kind: 'usage', message: 'rotate takes one id' };
    if (flag === undefined) return { kind: 'rotate', id, overlapSeconds: DEFAULT_ROTATION_OVERLAP_SECONDS };
    const overlapSeconds = Number(value);
    if (flag !== '--overlap' || !SECONDS.test(value ?? '') || overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS) {
        return { kind: 'usage', message: `--overlap is 0..${MAX_ROTATION_OVERLAP_SECONDS} seconds` };
    }
    return { kind: 'rotate', id, overlapSeconds };
}

export function parseDriverCredentialArgs(argv: readonly string[]): Parsed {
    const [command, ...rest] = argv;
    if (command === 'list' && rest.length === 0) return { kind: 'list' };
    if (command === 'issue') return parseIssue(rest);
    if (command === 'revoke' && rest.length === 1) return { kind: 'revoke', id: rest[0]! };
    if (command === 'rotate') return parseRotate(rest);
    return { kind: 'usage', message: command ? `unknown command: ${command}` : 'no command' };
}

export async function runDriverCredentialCommand(
    argv: readonly string[],
    store: DriverCredentialStore,
    io: CommandIo
): Promise<number> {
    const args = parseDriverCredentialArgs(argv);
    if (args.kind === 'usage') {
        io.err(`${args.message}\n${DRIVER_CREDENTIAL_USAGE}`);
        return USAGE_EXIT;
    }
    if (args.kind === 'list') {
        for (const credential of await store.list()) io.out(JSON.stringify(credential));
        return 0;
    }
    if (args.kind === 'issue') {
        const issued = await store.issue({ label: args.label, orgs: args.orgs, createdBy: null });
        if (issued.outcome === 'missing-org') {
            io.err(`no organization ${issued.orgId}`);
            return REFUSED_EXIT;
        }
        io.out(JSON.stringify(issued.credential));
        io.out(issued.token);
        return 0;
    }
    if (args.kind === 'revoke') {
        const revoked = await store.revoke(args.id);
        if (revoked.outcome === 'missing') {
            io.err(`no driver credential ${args.id}`);
            return REFUSED_EXIT;
        }
        io.out(JSON.stringify(revoked.credential));
        return 0;
    }
    const rotated = await store.rotate(args.id, args.overlapSeconds, null);
    if (rotated.outcome !== 'rotated') {
        io.err(
            rotated.outcome === 'missing'
                ? `no driver credential ${args.id}`
                : `driver credential ${args.id} is revoked or already rotated`
        );
        return REFUSED_EXIT;
    }
    io.out(JSON.stringify(rotated.credential));
    io.out(rotated.token);
    return 0;
}
