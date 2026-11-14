/*
 * Kubernetes quantity strings are the vocabulary both executors share — the pod specs take them
 * verbatim, and the docker flags take them translated (docker cannot parse `500m` or `1Gi`).
 * The two grammars here are deliberately narrower than k8s's: cpu is a decimal core count with an
 * optional `m` (never a byte suffix, which for cpu would be meaningless), memory is a number of
 * bytes with one of the SI/binary suffixes (never `m`, which on memory would be absurd). The
 * apiserver rejects anything else only at job-create time — attempt-burning — so the loader
 * refuses it here instead, naming the value (`runnerResource`, runner-classes.ts).
 */
const CPU_QUANTITY = /^(\d+(\.\d+)?)m?$/;
const MEMORY_QUANTITY = /^(\d+(\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|[kMGTPE])?$/;
/** Millicores per core: the `m` suffix of a cpu quantity. */
const MILLICORES_PER_CORE = 1000;
/** 10: the base the decimal fraction digits of a quantity are counted in, as a BigInt. */
const DECIMAL_BASE = 10n;
/** 1024: the base of the binary memory suffixes, multiplied out one step at a time below. */
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const BYTES_PER_GIB = BYTES_PER_MIB * BYTES_PER_KIB;
const BYTES_PER_TIB = BYTES_PER_GIB * BYTES_PER_KIB;
const BYTES_PER_PIB = BYTES_PER_TIB * BYTES_PER_KIB;
const BYTES_PER_EIB = BYTES_PER_PIB * BYTES_PER_KIB;
const MEMORY_SUFFIX_BYTES: Record<string, number> = {
    k: 1000,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: BYTES_PER_KIB,
    Mi: BYTES_PER_MIB,
    Gi: BYTES_PER_GIB,
    Ti: BYTES_PER_TIB,
    Pi: BYTES_PER_PIB,
    Ei: BYTES_PER_EIB,
};

/** A cpu quantity as docker's `--cpus` wants it: decimal cores — `500m` → `0.5`, `2` → `2`. */
export function cpuQuantityToCores(quantity: string): string {
    const match = CPU_QUANTITY.exec(quantity);
    if (!match) throw new Error(`"${quantity}" is not a cpu quantity (a decimal core count, optional "m" suffix)`);
    const value = Number(match[1]);
    return String(quantity.endsWith('m') ? value / MILLICORES_PER_CORE : value);
}

/** A memory quantity as docker's `--memory` wants it: plain bytes — `1Gi` → `1073741824`, `1G` → `1000000000`. */
export function memoryQuantityToBytes(quantity: string): string {
    const match = MEMORY_QUANTITY.exec(quantity);
    if (!match)
        throw new Error(`"${quantity}" is not a memory quantity (a byte count with an optional SI/binary suffix)`);
    // Exact integer scaling: binary floating-point multiplication rounds — `1.001 * 1e9` is
    // 1000999999.9999999, which would refuse the valid whole-byte quantity `1.001G`.
    const [whole = '', fraction = ''] = match[1]!.split('.');
    const scale = BigInt(match[3] ? MEMORY_SUFFIX_BYTES[match[3]]! : 1);
    const denominator = DECIMAL_BASE ** BigInt(fraction.length);
    const numerator = fraction ? BigInt(fraction) * scale : 0n;
    if (numerator % denominator !== 0n) throw new Error(`"${quantity}" is not a whole number of bytes`);
    return (BigInt(whole) * scale + numerator / denominator).toString();
}
