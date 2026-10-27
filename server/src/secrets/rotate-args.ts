export type RotateArgs =
    | { mode: 'rotate'; batchSize: number | undefined }
    | { mode: 'verify-retired'; keyId: string }
    | { mode: 'usage'; message: string };

const usage = (message: string): RotateArgs => ({ mode: 'usage', message });

/** `[--batch N]` re-encrypts under the active key; `--verify-retired <keyId>` counts what still names it. */
export function parseRotateArgs(argv: readonly string[]): RotateArgs {
    const [flag, value, ...rest] = argv;
    if (flag === undefined) return { mode: 'rotate', batchSize: undefined };
    if (rest.length > 0) return usage('too many arguments');
    if (flag === '--verify-retired') {
        return value === undefined || value === ''
            ? usage('--verify-retired needs a key id')
            : { mode: 'verify-retired', keyId: value };
    }
    if (flag === '--batch') {
        const n = Number(value);
        return Number.isInteger(n) && n > 0
            ? { mode: 'rotate', batchSize: n }
            : usage('--batch needs a positive integer');
    }
    return usage(`unknown argument ${flag}`);
}
