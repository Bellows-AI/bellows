// One job read (or POST) off the board, judged by shape, for the kubernetes and docker acceptance phases
// (scripts/acceptance-lib.sh). argv: <GET|POST> <url> <id|brief|session|cause> [json body]; env ACC_AUTH is
// the Authorization header value, when the board wants one.
// Prints the value, or "unread: <why>" for a read that failed or came back misshapen, or "refused: <status> <body>"
// for a POST the board answered other than 201: a failed or malformed read never yields a value a check can pass on.
const [method, url, kind, payload] = process.argv.slice(2);
const headers = { "content-type": "application/json" };
if (process.env.ACC_AUTH) headers.authorization = process.env.ACC_AUTH;
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (v) => typeof v === "string" && v !== "";
const brief = (j) => {
    if (!text(j.status) || !whole(j.attempts) || !Array.isArray(j.interruptions)) return "unread: malformed job";
    const list = j.interruptions;
    if (!list.every((i) => i && typeof i === "object" && whole(i.claimSeq) && typeof i.reason === "string")) return "unread: malformed interruptions";
    return [j.status, j.attempts, list.length, list[0]?.claimSeq ?? "", list[0]?.reason ?? ""].join("|");
};
const pick = { id: (j) => (text(j.id) && !/\s/.test(j.id) ? j.id : "unread: no job id"), brief, session: (j) => (text(j.sessionId) ? j.sessionId : "unread: no session"), cause: (j) => (text(j.failureKind) ? j.failureKind : "unread: no failure cause") };
(async () => {
    if (!Object.hasOwn(pick, kind)) return "unread: unknown kind " + kind;
    const r = await fetch(url, { method, headers, body: method === "POST" ? payload || "{}" : undefined, signal: AbortSignal.timeout(10000) });
    const raw = await r.text();
    if (r.status !== (method === "POST" ? 201 : 200)) return method === "POST" ? "refused: " + r.status + " " + raw.replace(/\s+/g, " ") : "unread: status " + r.status;
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (!j || typeof j !== "object" || Array.isArray(j)) return "unread: malformed body";
    return pick[kind](j);
})().then((v) => process.stdout.write(v), (e) => process.stdout.write("unread: " + e.message));
