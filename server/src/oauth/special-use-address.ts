import { BlockList, isIP } from 'node:net';

/**
 * Whether an address is one a public client document can never legitimately live at: loopback, private, link-local
 * (the cloud metadata address included), CGNAT, multicast, documentation and reserved ranges. An IPv6 form that wraps
 * an IPv4 address (mapped, SIIT, compatible, NAT64, 6to4) is judged by the IPv4 address inside it. Anything unparseable is
 * special.
 */
const V4_SPECIAL = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
];
const V6_SPECIAL = [
    '::/128',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'fec0::/10',
    'ff00::/8',
    '2001:db8::/32',
    '64:ff9b:1::/48',
];
const special = new BlockList();
for (const cidr of V4_SPECIAL) addSubnet(cidr, 'ipv4');
for (const cidr of V6_SPECIAL) addSubnet(cidr, 'ipv6');

function addSubnet(cidr: string, family: 'ipv4' | 'ipv6'): void {
    const [net = '', prefix = ''] = cidr.split('/');
    special.addSubnet(net, Number(prefix), family);
}

const V4 = 4;
const V6 = 6;
const HEX = 16;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const GROUPS = 8;
const GROUP_MAX = 0xffff;

/** The compressed lower-case form of an IPv6 address, or null when it is not one. */
const canonicalV6 = (address: string): string | null => {
    try {
        return new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
        return null;
    }
};

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
export const expandV6 = (address: string): number[] | null => {
    const canonical = isIP(address) === V6 ? canonicalV6(address) : null;
    if (canonical === null) return null;
    const [head = '', tail] = canonical.split('::');
    const groups = (text: string) => (text === '' ? [] : text.split(':').map((g) => parseInt(g, HEX)));
    const [first, last] = [groups(head), tail === undefined ? [] : groups(tail)];
    const zeros = tail === undefined ? [] : new Array<number>(GROUPS - first.length - last.length).fill(0);
    const all = [...first, ...zeros, ...last];
    return all.length === GROUPS && all.every((g) => g >= 0 && g <= GROUP_MAX) ? all : null;
};

export const v4Of = (high: number, low: number): string =>
    [high >> BYTE_BITS, high & BYTE_MASK, low >> BYTE_BITS, low & BYTE_MASK].join('.');

const NAT64 = 0x64;
const NAT64_2 = 0xff9b;
const SIX_TO_FOUR = 0x2002;
const LAST_TWO = 6;
const SECOND_TWO = 1;
/** Each form is a run of leading groups; the wrapped IPv4 address is in the two groups at `from`. */
const EMBEDDED: { prefix: number[]; from: number }[] = [
    { prefix: [0, 0, 0, 0, 0, GROUP_MAX], from: LAST_TWO },
    { prefix: [0, 0, 0, 0, GROUP_MAX, 0], from: LAST_TWO },
    { prefix: [0, 0, 0, 0, 0, 0], from: LAST_TWO },
    { prefix: [NAT64, NAT64_2, 0, 0, 0, 0], from: LAST_TWO },
    { prefix: [SIX_TO_FOUR], from: SECOND_TWO },
];

/** The IPv4 address an IPv6 form wraps, judged on all eight groups: mapped, SIIT, compatible, NAT64 and 6to4. */
const embeddedV4 = (groups: number[]): string | null => {
    const form = EMBEDDED.find(({ prefix }) => prefix.every((g, i) => groups[i] === g));
    return form ? v4Of(groups[form.from] ?? 0, groups[form.from + 1] ?? 0) : null;
};

export const isSpecialUseAddress = (address: string): boolean => {
    if (isIP(address) === V4) return special.check(address, 'ipv4');
    const groups = expandV6(address);
    if (groups === null) return true;
    const v4 = embeddedV4(groups);
    if (v4 !== null) return special.check(v4, 'ipv4');
    return special.check(groups.map((g) => g.toString(HEX)).join(':'), 'ipv6');
};

/** `127.0.0.0/8` or `::1`: the one special range the dev policy opens. */
export const isLoopbackAddress = (address: string): boolean => {
    if (isIP(address) === V4) return address.startsWith('127.');
    return canonicalV6(address) === '::1';
};
