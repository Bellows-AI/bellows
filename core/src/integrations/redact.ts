const MASK = '[redacted]';

/** Replace every occurrence of every non-empty secret, longest first so a prefix cannot leave a tail. */
export const redact = (text: string, secrets: readonly string[]): string => {
    let out = text;
    for (const secret of [...secrets].filter((s) => s !== '').sort((a, b) => b.length - a.length)) {
        out = out.split(secret).join(MASK);
    }
    return out;
};
