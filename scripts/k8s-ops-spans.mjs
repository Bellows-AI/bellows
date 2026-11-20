// Judges the ops collector's file-exporter output for the kind lane (scripts/lanes/k8s/observability.sh):
// reads the JSONL on stdin and prints ONE line, exit 0 only for `joined`:
//   joined <traceId>   a bellows-board span and a bellows-driver span share a trace, and every such
//                      resource carries k8s.pod.name, k8s.namespace.name and service.instance.id
//   missing: <board|driver|join|resource-attributes>   the whole file parsed and the condition fails
//   unread: <reason>   empty input or a malformed COMPLETE line: nothing was judged
// Only newline-terminated lines are parsed: the trailing fragment is the exporter's write in progress
// (or a stream cut short by the lane's deadline) and is ignored.
const BOARD = 'bellows-board';
const DRIVER = 'bellows-driver';
const POD_ATTRIBUTES = ['k8s.pod.name', 'k8s.namespace.name', 'service.instance.id'];

const finish = (line) => {
    process.stdout.write(line);
    process.exit(line.startsWith('joined ') ? 0 : 1);
};

const judge = (text) => {
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete === '') return 'unread: no complete line';
    const resources = [];
    for (const line of complete.split('\n')) {
        if (line === '') continue;
        let doc;
        try {
            doc = JSON.parse(line);
        } catch {
            return 'unread: malformed line';
        }
        if (!doc || !Array.isArray(doc.resourceSpans)) return 'unread: line is not resourceSpans';
        for (const resourceSpans of doc.resourceSpans) {
            const attributes = new Map((resourceSpans.resource?.attributes ?? []).map((a) => [a.key, a.value?.stringValue]));
            const traces = (resourceSpans.scopeSpans ?? []).flatMap((scope) => (scope.spans ?? []).map((span) => span.traceId));
            resources.push({ service: attributes.get('service.name'), attributes, traces });
        }
    }
    const board = resources.filter((r) => r.service === BOARD);
    const driver = resources.filter((r) => r.service === DRIVER);
    if (board.length === 0) return 'missing: board';
    if (driver.length === 0) return 'missing: driver';
    if (![...board, ...driver].every((r) => POD_ATTRIBUTES.every((key) => r.attributes.get(key)))) {
        return 'missing: resource-attributes';
    }
    const boardTraces = new Set(board.flatMap((r) => r.traces));
    const shared = driver.flatMap((r) => r.traces).find((id) => boardTraces.has(id));
    return shared === undefined ? 'missing: join' : `joined ${shared}`;
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('error', (error) => finish(`unread: ${error.message}`));
process.stdin.on('end', () => finish(judge(input)));
