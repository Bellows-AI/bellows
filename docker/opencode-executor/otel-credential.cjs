#!/usr/bin/env node
'use strict';
/**
 * The opencode-otel plugin's credentialed config (docs/telemetry.md). The attempt's job id and
 * ingest token ride OTEL_EXPORTER_OTLP_HEADERS, which the plugin never reads: it takes headers from
 * its otel.json alone, and the driver-rendered one (OPENCODE_OTEL_CONFIG_PATH) is root-owned and
 * world-readable, so it names no credential. This copies it with the headers merged in under the
 * CLI's HOME — a 0600 file in a 0700 directory no tool uid can enter — and prints the copy's path
 * for the entrypoint to point the plugin at. The root-owned file is only read, never written; the
 * copy is replaced on every start, so nothing the agent edits there outlives its run.
 *
 * Everything comes from the environment, never argv: a tool can read any process's argv. Exit 1,
 * printing nothing, when there is nothing to write or it cannot be written.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** `key=value,key=value`, the OTLP spec's header list, as an object. */
function parseHeaders(list) {
    const headers = {};
    for (const pair of list.split(',')) {
        const at = pair.indexOf('=');
        if (at > 0) headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    return headers;
}

function writeCopy(env) {
    const list = env.OTEL_EXPORTER_OTLP_HEADERS;
    if (!list || !env.HOME || !env.OPENCODE_OTEL_CONFIG_PATH) return null;
    const config = JSON.parse(fs.readFileSync(env.OPENCODE_OTEL_CONFIG_PATH, 'utf8'));
    const dir = path.join(env.HOME, '.factory-otel');
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    const copy = path.join(dir, 'otel.json');
    fs.rmSync(copy, { force: true });
    fs.writeFileSync(copy, JSON.stringify({ ...config, headers: parseHeaders(list) }), { mode: FILE_MODE, flag: 'wx' });
    return copy;
}

if (require.main === module) {
    try {
        const copy = writeCopy(process.env);
        if (!copy) process.exit(1);
        process.stdout.write(copy);
    } catch {
        process.exit(1);
    }
}

module.exports = { parseHeaders, writeCopy };
