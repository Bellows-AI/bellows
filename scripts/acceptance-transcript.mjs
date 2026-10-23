// Reads a job's whole artifact stream from the board and judges it against the stub's records
// (scripts/k8s-stub.sh `factory-stub-transcript-<n>`), for the kubernetes and docker acceptance
// phases (scripts/acceptance-lib.sh). argv: <artifacts url> <session> <first> <last> [lossy];
// env ACC_AUTH is the Authorization header value, when the board wants one.
// Prints "exact", "bad: <why>" or "unread: <why>"; a read that failed is never a negative verdict.
const headers = { 'content-type': 'application/json' };
if (process.env.ACC_AUTH) headers.authorization = process.env.ACC_AUTH;
const unbounded = fetch;
// A board that never answers is a refusal like any other, never a lane that hangs.
globalThis.fetch = (url, init = {}) => unbounded(url, { signal: AbortSignal.timeout(10000), ...init });
const [base, session, first, last, lossy] = [process.argv[2], process.argv[3], Number(process.argv[4]), Number(process.argv[5]), process.argv[6] === "lossy"];
const record = (i) => JSON.stringify({ type: "user", uuid: "stub-record-" + i, sessionId: session, message: { role: "user", content: "stub record " + i } }) + "\n";
const want = (a, b) => { let t = ""; for (let i = a; i <= b; i++) t += record(i); return t; };
const url = (cursor) => base + "/read?session=" + encodeURIComponent(session) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
(async () => {
    let cursor = "", text = "", segments = [], streams = [];
    for (let page = 0; page < 100; page++) {
        const r = await fetch(url(cursor), { headers });
        if (r.status !== 200) return "unread: status " + r.status;
        const b = await r.json().catch(() => null);
        if (!b || !Array.isArray(b.segments) || !Array.isArray(b.streams)) return "unread: malformed body";
        streams = b.streams;
        segments.push(...b.segments);
        if (!b.nextCursor) break;
        cursor = b.nextCursor;
    }
    if (streams.length === 0) return "bad: no stream for the session";
    // The last attempt's stream must be closed complete. An earlier one a lost pod never finalized stays
    // partial (not_finalized, or agent_killed once a drain closed it) — only when the caller says a pod was lost — and its chunks are still read.
    const ordered = [...streams].sort((x, y) => x.attempt - y.attempt);
    const states = ordered.map((s) => s.state + (s.terminalCause ? "/" + s.terminalCause : ""));
    const closed = (s, i) => s.state === "complete" || (lossy && i < ordered.length - 1 && s.state === "partial" && ["not_finalized", "agent_killed"].includes(s.terminalCause));
    if (!ordered.every(closed)) return "bad: stream states " + states.join(",");
    let at = Buffer.byteLength(want(1, first - 1));
    const start = at;
    for (const s of segments) {
        if (s.state !== "ok" || typeof s.text !== "string") return "bad: segment " + s.offset + " is " + s.state;
        if (s.offset !== at) return "bad: segment at " + s.offset + ", expected " + at + " (start " + start + ")";
        at += s.length;
        text += s.text;
    }
    return text === want(first, last) ? "exact" : "bad: " + text.length + " chars read, expected records " + first + ".." + last + ": " + JSON.stringify(text.slice(0, 160));
})().then((v) => process.stdout.write(v), (e) => process.stdout.write("unread: " + e.message));
