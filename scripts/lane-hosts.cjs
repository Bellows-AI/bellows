// Preloaded (`node --require`) by a lane's host process that must resolve a name only the lane's containers know
// (`host.docker.internal`, which docker adds to a container, never to the host): LANE_HOSTS="name=address,..." answers
// those names from dns.lookup and leaves every other name to the resolver. A host tool, never a container script.
'use strict';
const dns = require('node:dns');

const known = new Map(
    String(process.env.LANE_HOSTS ?? '')
        .split(',')
        .map((pair) => pair.split('='))
        .filter(([name, address]) => name && address)
);
const lookup = dns.lookup;
dns.lookup = function lookupKnown(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    const address = known.get(hostname);
    if (address === undefined) return lookup.call(dns, hostname, options, callback);
    const family = address.includes(':') ? 6 : 4;
    process.nextTick(() => (opts.all ? done(null, [{ address, family }]) : done(null, address, family)));
};
