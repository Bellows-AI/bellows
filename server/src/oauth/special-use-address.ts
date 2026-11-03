import { BlockList, isIP } from 'node:net';

/**
 * Whether an address is one a public client document can never legitimately live at: loopback, private, link-local
 * (the cloud metadata address included), CGNAT, multicast, documentation and reserved ranges. An IPv6 form that wraps
 * an IPv4 address (mapped, compatible, NAT64, 6to4) is judged by the IPv4 address inside it. Anything unparseable is
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
const V6_SPECIAL = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8', '2001:db8::/32'];
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
const GROUP = '([0-9a-f]{1,4})';
/** Each form embeds an IPv4 address in two trailing (or, for 6to4, leading) groups; the canonical text comes from URL. */
const EMBEDDED = [
    new RegExp(`^::ffff:${GROUP}:${GROUP}$`),
    new RegExp(`^64:ff9b::${GROUP}:${GROUP}$`),
    new RegExp(`^2002:${GROUP}:${GROUP}(:|$)`),
    new RegExp(`^::${GROUP}:${GROUP}$`),
];

const v4Of = (high: string, low: string): string => {
    const [h, l] = [parseInt(high, HEX), parseInt(low, HEX)];
    return [h >> BYTE_BITS, h & BYTE_MASK, l >> BYTE_BITS, l & BYTE_MASK].join('.');
};

/** The compressed lower-case form of an IPv6 address, or null when it is not one. */
const canonicalV6 = (address: string): string | null => {
    try {
        return new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
        return null;
    }
};

export const isSpecialUseAddress = (address: string): boolean => {
    const family = isIP(address);
    if (family === V4) return special.check(address, 'ipv4');
    const canonical = family === V6 ? canonicalV6(address) : null;
    if (canonical === null) return true;
    for (const form of EMBEDDED) {
        const match = form.exec(canonical);
        if (match) return special.check(v4Of(match[1] ?? '', match[2] ?? ''), 'ipv4');
    }
    return special.check(canonical, 'ipv6');
};

/** `127.0.0.0/8` or `::1`: the one special range the dev policy opens. */
export const isLoopbackAddress = (address: string): boolean => {
    if (isIP(address) === V4) return address.startsWith('127.');
    return canonicalV6(address) === '::1';
};
