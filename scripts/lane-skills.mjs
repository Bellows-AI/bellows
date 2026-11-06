// Publishes a skill bundle through the board's real routes, for the pinned-skills lane (scripts/test-jobs.sh).
//
//   node scripts/lane-skills.mjs <base url> <token> <route> <name> <description> [--id <skill id>] [path=content …]
//
// A zip of SKILL.md plus every `path=content` helper file is POSTed as `application/zip`: to <route>?name= when it is a
// new skill, to <route>/<id>/versions when --id names one (a new version of the same skill). Prints the response as
// one JSON line `{status, id, sha256}`; `id` and `sha256` are empty when the board refused.
import { Buffer } from 'node:buffer';

const [base, token, route, name, description, ...rest] = process.argv.slice(2);
const idAt = rest.indexOf('--id');
const id = idAt === -1 ? '' : rest[idAt + 1];
const helpers = rest.filter((_, at) => idAt === -1 || (at !== idAt && at !== idAt + 1));

const entries = [
    { path: 'SKILL.md', data: `---\nname: ${name}\ndescription: ${description}\n---\n\nNothing to do.\n` },
    ...helpers.map((helper) => ({ path: helper.slice(0, helper.indexOf('=')), data: helper.slice(helper.indexOf('=') + 1) })),
];

/** A stored (uncompressed) zip; the board's codec does not check CRCs. */
function zip(files) {
    const local = [];
    const central = [];
    let offset = 0;
    const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
    const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    for (const file of files) {
        const path = Buffer.from(file.path);
        const data = Buffer.from(file.data);
        const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(path.length), u16(0), path]);
        central.push(
            Buffer.concat([u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(path.length), u16(0), u16(0), u16(0), u16(0), u32(0o100644 << 16), u32(offset), path])
        );
        local.push(head, data);
        offset += head.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(directory.length), u32(offset), u16(0)]);
    return Buffer.concat([...local, directory, end]);
}

const url = id === '' ? `${base}${route}?name=${encodeURIComponent(name)}` : `${base}${route}/${id}/versions`;
const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body: zip(entries),
    signal: AbortSignal.timeout(15000),
});
const text = await response.text();
let skill = {};
try {
    skill = JSON.parse(text).skill ?? {};
} catch {
    // a refusal is not always JSON; the status says it
}
process.stdout.write(`${JSON.stringify({ status: response.status, id: skill.id ?? '', sha256: skill.current?.sha256 ?? '', body: response.ok ? '' : text.slice(0, 200) })}\n`);
