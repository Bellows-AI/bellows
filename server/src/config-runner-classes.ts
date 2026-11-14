/**
 * The runner classes the board lets an org executor profile name (RUNNER_CLASSES): the same JSON map the
 * chart hands the driver, of which the board reads each class's name and docker flag only. The driver
 * stays the authority on everything else in a class, and refuses a claim naming a class it does not
 * declare. Unset or empty declares no class, and every profile then runs in the driver's default.
 */
export interface RunnerClassOption {
    readonly name: string;
    /** Whether the class's groups get a docker daemon. */
    readonly docker: boolean;
}

const ERROR_PREVIEW_CHARS = 80;
/** A class name is a DNS-1123 label, as the driver requires: it is a pod label value and a CEL key. */
const DNS_LABEL_MAX = 63;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const preview = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, ERROR_PREVIEW_CHARS);

/**
 * Parsed at boot and fatal on a malformed value: a map the board cannot read never becomes "no
 * classes", which would quietly strip every class from the profiles an admin edits next.
 */
export function loadRunnerClassOptions(raw: string | undefined): readonly RunnerClassOption[] {
    const text = (raw ?? '').trim();
    if (!text) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`RUNNER_CLASSES must be JSON, got "${text.slice(0, ERROR_PREVIEW_CHARS)}"`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`RUNNER_CLASSES must be a JSON object of classes by name, got ${preview(parsed)}`);
    }
    return Object.entries(parsed).map(([name, value]) => {
        if (name.length > DNS_LABEL_MAX || !DNS_LABEL.test(name)) {
            throw new Error(
                `RUNNER_CLASSES declares a class "${name.slice(0, ERROR_PREVIEW_CHARS)}" whose name is not a DNS-1123 label`
            );
        }
        if (value === null || value === undefined) return { name, docker: false };
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`RUNNER_CLASSES.${name} must be a JSON object, got ${preview(value)}`);
        }
        const { docker } = value as { docker?: unknown };
        if (docker !== undefined && docker !== null && typeof docker !== 'boolean') {
            throw new Error(`RUNNER_CLASSES.${name}.docker must be true or false, got ${preview(docker)}`);
        }
        return { name, docker: docker === true };
    });
}
