/**
 * Why a runner group could not start, decided once over both executors (issue #824 D11): the
 * platform's own words — a kubelet waiting reason, a registry or daemon message — read for positive
 * evidence only. A transient cause (the registry or the daemon could not answer, the node never
 * brought the group up) is an interruption the board refunds within its budget; a permanent one (no
 * such image, a refused credential, an untrusted registry, a container spec the platform rejects) is
 * a configuration fault a person fixes. Words that prove neither are no cause at all: the path keeps
 * the recovery it had.
 */

export const STARTUP_CAUSES = ['transient', 'image', 'auth', 'config'] as const;
export type StartupCause = (typeof STARTUP_CAUSES)[number];

/** Which of the group's containers a refusal held (#773 D10): the executor's own, the gate's, or a declared service's. */
export interface HeldContainer {
    role: 'executor' | 'gate' | 'service';
    /** The declared service's name, for the `service` role only. */
    service?: string;
}

/** How a refusal names the container it held: `executor`, `gate`, or `service "db"`. */
export const heldWords = ({ role, service }: HeldContainer): string =>
    role === 'service' ? `service "${service}"` : role;

/** A group start the platform refused, with the cause its own words prove and the container it held. */
export class StartupRefused extends Error {
    readonly role: HeldContainer['role'];
    readonly service: string | undefined;

    constructor(
        message: string,
        readonly startupCause: StartupCause,
        held: HeldContainer = { role: 'executor' }
    ) {
        super(message);
        this.name = 'StartupRefused';
        this.role = held.role;
        this.service = held.service;
    }
}

/** The kubelet's waiting reasons that name their cause outright, whatever the message says. */
const TYPED_REASONS: Readonly<Record<string, StartupCause>> = {
    InvalidImageName: 'image',
    CreateContainerConfigError: 'config',
};

/**
 * Message evidence, most specific first: a trust failure is checked before the timeouts it can
 * mention. Read only from the platform's error wording (`evidenceOf`): every reference the message
 * quotes — an image, a repository, a host, a digest — is taken out first, since any of them may be
 * named after a keyword. `image` needs words that name a missing image or manifest: a NotFound or a
 * 404 alone may be a missing digest, a network, a volume or a registry with no API.
 */
const EVIDENCE: readonly (readonly [StartupCause, RegExp])[] = [
    [
        'config',
        /x509:|certificate signed by unknown authority|certificate is valid for|tls: failed to verify certificate|certificate has expired|invalid mount config/i,
    ],
    [
        'auth',
        /unauthorized: |401 Unauthorized|authentication required|pull access denied|requested access to the resource is denied|no basic auth credentials|\b403 Forbidden\b/i,
    ],
    [
        'image',
        /manifest unknown|manifest for REF not found|repository does not exist|no such image|invalid reference format|failed to resolve reference "…": REF: not found/i,
    ],
    [
        'transient',
        /i\/o timeout|TLS handshake timeout|timed out|timeout exceeded|context deadline exceeded|connection refused|connection reset|toomanyrequests|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|Cannot connect to the Docker daemon|error during connect|services have not yet been read at least once/i,
    ],
];

/** What the message quotes, never its error wording: quoted text, URLs, `host/path[:tag]`, `name:tag` / `host:port` / `sha256:` references and dotted host names. */
const REFERENCES: readonly (readonly [RegExp, string])[] = [
    [/"[^"\n]*"/g, '"…"'],
    [/'[^'\n]*'/g, '"…"'],
    [/\bhttps?:\/\/\S+/g, 'REF'],
    [/[\w.-]{2,}(?::\d+)?\/[\w.-]{2,}[\w./-]*(?::[\w.-]+)?(?:@sha256:[0-9a-f]+)?/g, 'REF'],
    [/\b[\w.-]+:[\w.-]+(?:@sha256:[0-9a-f]+)?/g, 'REF'],
    [/\b[\w-]+(?:\.[\w-]+)+\b/g, 'REF'],
];

/** A refusal's error wording alone, every reference it quotes taken out. */
function evidenceOf(message: string): string {
    return REFERENCES.reduce((text, [pattern, stand]) => text.replace(pattern, stand), message);
}

/** The cause a refusal's own words prove, or null when they prove none. */
export function startupCauseOf(refusal: {
    waitingReason?: string | null;
    message?: string | null;
}): StartupCause | null {
    const words = evidenceOf(refusal.message ?? '');
    const said = EVIDENCE.find(([, pattern]) => pattern.test(words))?.[0] ?? null;
    const typed = refusal.waitingReason ? TYPED_REASONS[refusal.waitingReason] : undefined;
    // A typed reason names its class, but the kubelet files a timeout it hit on the way under it
    // too (a secret cache that did not sync): an explicit transient in its words outranks it.
    if (typed) return said === 'transient' ? 'transient' : typed;
    return said;
}

/** Whether a cause is one a retry can outlive (an interruption) rather than one a person fixes (a fault). */
export const transientStartup = (cause: StartupCause): boolean => cause === 'transient';
