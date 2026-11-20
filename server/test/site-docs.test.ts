import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { USAGE } from '../../cli/src/usage.js';
import { ALL_BATCH_TOOLS, TOOLS } from '../src/mcp/registry.js';
import { parseBellowsWithPolicy } from '../src/workspace/bellows.js';
import { parseServices } from '../src/workspace/bellows-services.js';

/** The user docs hand-copy facts from the code; this pins each copy (AGENTS.md, `site/`). */
const site = fileURLToPath(new URL('../../site/', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

const mdxFiles = (dir = site): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? mdxFiles(join(dir, entry.name))
            : entry.name.endsWith('.mdx')
              ? [join(dir, entry.name)]
              : []
    );
const read = (file: string) => readFileSync(join(site, file), 'utf8');
const diff = (code: Set<string>, docs: Set<string>, where: string) => ({
    undocumented: [...code].filter((name) => !docs.has(name)).sort(),
    [`stale in ${where}`]: [...docs].filter((name) => !code.has(name)).sort(),
});

describe('site/ .bellows.yaml examples', () => {
    it('every full example parses under the board policy and the services parser', () => {
        const failures: string[] = [];
        for (const file of mdxFiles()) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/^([ \t]*)```ya?ml([^\n]*)\n([\s\S]*?)\n\1```/gm)) {
                const [, indent = '', meta = '', raw = ''] = m;
                if (!/\.bellows\.yaml/.test(meta) || /excerpt/.test(meta)) continue;
                const body = raw
                    .split('\n')
                    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
                    .join('\n');
                const line = src.slice(0, m.index).split('\n').length;
                try {
                    parseBellowsWithPolicy(body);
                    parseServices(body);
                } catch (e) {
                    failures.push(`${relative(site, file)}:${line} ${(e as Error).message}`);
                }
            }
        }
        expect(failures, 'site/ .bellows.yaml example the parser rejects').toEqual([]);
    });

    // A stock postgres chowns its data directory as root at first boot and crash-loops under the
    // services' hardening (docs/jobs.md): a copied example must carry the `user:` that avoids it.
    it('every postgres service in an example declares a user', () => {
        const missing: string[] = [];
        for (const file of mdxFiles()) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/^([ \t]*)```ya?ml([^\n]*)\n([\s\S]*?)\n\1```/gm)) {
                const [, , meta = '', body = ''] = m;
                if (!/\.bellows\.yaml/.test(meta) || /excerpt/.test(meta) || !/^services:/m.test(body)) continue;
                for (const service of parseServices(body)) {
                    if (/(^|\/)postgres(:|@|$)/.test(service.image) && service.user === undefined)
                        missing.push(
                            `${relative(site, file)}:${src.slice(0, m.index).split('\n').length} ${service.name}`
                        );
                }
            }
        }
        expect(missing).toEqual([]);
    });

    // A tmpfs mount root is root-owned and world-writable on both executors; postgres as uid 999
    // cannot chmod it 0700, so a copied example must point PGDATA at a subdirectory of the mount.
    it('every postgres service with a tmpfs keeps PGDATA in a subdirectory of it', () => {
        const wrong: string[] = [];
        for (const file of mdxFiles()) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/^([ \t]*)```ya?ml([^\n]*)\n([\s\S]*?)\n\1```/gm)) {
                const [, , meta = '', body = ''] = m;
                if (!/\.bellows\.yaml/.test(meta) || /excerpt/.test(meta) || !/^services:/m.test(body)) continue;
                for (const service of parseServices(body)) {
                    if (!/(^|\/)postgres(:|@|$)/.test(service.image) || !service.tmpfs) continue;
                    const pgdata = service.environment.find((e) => e.key === 'PGDATA')?.value;
                    if (!service.tmpfs.some((t) => pgdata?.startsWith(`${t.path}/`)))
                        wrong.push(
                            `${relative(site, file)}:${src.slice(0, m.index).split('\n').length} ${service.name}`
                        );
                }
            }
        }
        expect(wrong).toEqual([]);
    });
});

describe('site/mcp/tools.mdx', () => {
    it('documents exactly the registered non-batch MCP tools', () => {
        const batch = new Set(ALL_BATCH_TOOLS.map((t) => t.name));
        const code = new Set(TOOLS.map((t) => t.name).filter((name) => !batch.has(name)));
        const docs = new Set([...read('mcp/tools.mdx').matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] as string));
        expect(diff(code, docs, 'tools.mdx')).toEqual({ undocumented: [], 'stale in tools.mdx': [] });
    });
});

describe('site/cli/commands.mdx', () => {
    // Every command line of USAGE starts `bellows <group> <verb>`; continuation lines do not.
    const key = (text: string) => /^\s*(?:usage: )?bellows ([a-z]+)(?: ([a-z-]+))?/.exec(text);
    it('documents exactly the non-batch CLI commands of cli/src/usage.ts', () => {
        const code = new Set<string>();
        for (const line of USAGE.split('\n')) {
            const m = key(line);
            if (m && m[1] !== 'batch') code.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!);
        }
        const docs = new Set<string>();
        for (const m of read('cli/commands.mdx').matchAll(/^\| `bellows ([a-z]+)(?: ([a-z-]+))?/gm)) {
            if (m[1] !== 'batch') docs.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!);
        }
        expect(diff(code, docs, 'commands.mdx')).toEqual({ undocumented: [], 'stale in commands.mdx': [] });
    });
});

describe('site/docs.json', () => {
    const pagesOf = (node: unknown): string[] =>
        typeof node === 'string'
            ? [node]
            : Array.isArray(node)
              ? node.flatMap(pagesOf)
              : node && typeof node === 'object'
                ? ['pages', 'groups', 'tabs', 'anchors', 'dropdowns', 'versions', 'languages', 'menu'].flatMap((k) =>
                      pagesOf((node as Record<string, unknown>)[k])
                  )
                : [];
    it('lists every page that exists, and only pages that exist', () => {
        const nav = (JSON.parse(read('docs.json')) as { navigation: unknown }).navigation;
        const listed = new Set(pagesOf(nav));
        const files = new Set(mdxFiles().map((f) => relative(site, f).replace(/\.mdx$/, '')));
        expect({
            'listed but missing': [...listed]
                .filter((p) => !files.has(p) && !existsSync(join(site, `${p}.mdx`)))
                .sort(),
            'present but not listed': [...files].filter((p) => !listed.has(p)).sort(),
        }).toEqual({ 'listed but missing': [], 'present but not listed': [] });
    });
});

describe('site/self-host/monitoring.mdx', () => {
    // An absent page reads as '' so the failure lists every missing name instead of throwing ENOENT.
    const page = existsSync(join(site, 'self-host/monitoring.mdx')) ? read('self-host/monitoring.mdx') : '';
    const documented = (name: string) => page.includes(`\`${name}\``);

    /** Key paths under a plain object; stops at `stop`, which is named once. */
    const keyPaths = (node: Record<string, unknown>, prefix: string, stop: string): string[] =>
        Object.entries(node).flatMap(([key, value]) => {
            const path = `${prefix}.${key}`;
            return value && typeof value === 'object' && !Array.isArray(value) && key !== stop
                ? keyPaths(value as Record<string, unknown>, path, stop)
                : [path];
        });

    it('names every observability chart value', () => {
        const values = parseYaml(readFileSync(join(repo, 'charts/factory/values.yaml'), 'utf8')) as Record<
            string,
            unknown
        >;
        const block = values.observability;
        expect(
            block && typeof block === 'object' && !Array.isArray(block),
            'values.yaml has no observability map'
        ).toBe(true);
        const keys = keyPaths(block as Record<string, unknown>, 'observability', 'resources');
        expect(keys.length).toBeGreaterThanOrEqual(8);
        expect(keys.filter((key) => !documented(key))).toEqual([]);
    });

    it('names every dashboard and alert rule file', () => {
        const dashboards = readdirSync(join(repo, 'observability/dashboards')).filter((f) => f.endsWith('.json'));
        const rules = readdirSync(join(repo, 'observability/alerts')).filter((f) => f.endsWith('.yaml'));
        expect(dashboards.length).toBeGreaterThanOrEqual(5);
        expect(rules.length).toBeGreaterThanOrEqual(3);
        const paths = [
            ...dashboards.map((f) => `observability/dashboards/${f}`),
            ...rules.map((f) => `observability/alerts/${f}`),
        ];
        expect(paths.filter((path) => !documented(path))).toEqual([]);
    });

    // The Kubernetes guide installs release `bellows` into namespace `bellows`; a copied command must hit it.
    it('its helm and kubectl commands target the release and namespace the Kubernetes guide installs', () => {
        const commands = page.replace(/\\\n/g, ' ').match(/^\s*(helm|kubectl) .*$/gm) ?? [];
        expect(commands.length).toBeGreaterThan(0);
        const wrong = commands.filter(
            (c) =>
                !/(-n|--namespace) bellows\b/.test(c) ||
                (c.includes('helm') && !/helm upgrade bellows oci:\/\//.test(c))
        );
        expect(wrong).toEqual([]);
    });

    it('kubernetes.mdx carries no Prometheus scrape instruction', () => {
        const kubernetes = read('self-host/kubernetes.mdx');
        expect(kubernetes).not.toMatch(/prometheus\.io\//);
        expect(kubernetes).not.toMatch(/\/metrics/);
    });
});
