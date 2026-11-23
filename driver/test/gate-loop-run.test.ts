import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateLoopScript } from '../src/container-scripts.js';

/*
 * The gate loop (`scripts/gate-loop.sh`) EXECUTED, which is only safe in a pid namespace of its own: its
 * `kill -KILL -1` reaches every process the running user can signal. `unshare -Upf` gives the harness a
 * user and a pid namespace, so the sweep ends the loop's gates and nothing of the suite's. A host that
 * refuses unprivileged namespaces skips this file; scripts/test-k8s.sh and scripts/test-jobs.sh run the
 * loop for real.
 */
const NAMESPACED = spawnSync('unshare', ['-Upf', 'true']).status === 0;

/** What every harness starts with: the loop running beside it as a namespace's init would, and the helpers to post to it. */
const PRELUDE = String.raw`
box=$BOX
export FACTORY_GATE_DIR=$box
mkdir -p "$box" "$WORK"
/bin/sh -c "$LOOP_SCRIPT" gate-loop 'exec /bin/sh -c "$1"' 'echo gh' > "$BOX.log" 2>&1 &
nap() { /bin/sleep "$1" 2>/dev/null || /bin/sleep "$1" 2>/dev/null || true; }
waitfor() {
    n=0
    until eval "$1"; do
        nap 0.1
        n=$((n + 1))
        [ $n -gt 300 ] && { echo "TIMEOUT $1"; exit 1; }
    done
}
post() {
    d="$box/staging-$1"
    mkdir -p "$d"
    printf '%s' "$2" > "$d/command"
    printf '%s' "$WORK" > "$d/cwd"
    : > "$d/env"
    [ -n "$3" ] && : > "$d/parallel"
    mv "$d" "$box/requests/$1"
}
answer() { echo "$1 exit=$(cat "$box/done/$1/exit") out=$(cat "$box/done/$1/output" | tr '\n' ' ')"; }
waitfor "[ -e $box/alive ]"
echo "parallel=$([ -e $box/parallel ] && echo yes || echo no)"
`;

/** Four scenarios of the loop with `setsid`: side by side, a cancel beside another, a lone cancel, a leftover. */
const SCENARIOS = `
echo "== two requests side by side"
post a 'sleep 1; echo A' marked
post b 'sleep 1; echo B' marked
waitfor "[ -s $box/running/a/pgid ] && [ -s $box/running/b/pgid ]"
echo "both ran at once"
waitfor "[ -e $box/done/a/exit ] && [ -e $box/done/b/exit ]"
answer a
answer b

echo "== a cancel kills its own gate and spares the one beside it"
post c 'sleep 30; echo C-survived' marked
post d 'sleep 3; echo D' marked
waitfor "[ -s $box/running/c/pgid ] && [ -s $box/running/d/pgid ]"
touch "$box/running/c/cancel"
waitfor "[ -e $box/done/c/exit ]"
echo "d still running when c was answered: $([ -d $box/running/d ] && echo yes || echo no)"
answer c
waitfor "[ -e $box/done/d/exit ]"
answer d

echo "== an unmarked request waits for a marked one that runs"
post g 'sleep 2; echo G' marked
waitfor "[ -s $box/running/g/pgid ]"
post h 'echo H'
nap 0.7
echo "h taken while g runs: $([ -d $box/running/h ] && echo yes || echo no)"
waitfor "[ -e $box/done/h/exit ]"
answer h

echo "== a cancel with nothing else running sweeps what the gate left behind"
post e 'sleep 30 & sleep 30'
waitfor "[ -s $box/running/e/pgid ]"
touch "$box/running/e/cancel"
waitfor "[ -e $box/done/e/exit ]"
answer e

echo "== a background process of a finished gate does not outlive its answer"
post f '(sleep 3; echo late > "$WORK/late") & echo F'
waitfor "[ -e $box/done/f/exit ]"
answer f
nap 3.5
echo "late=$([ -e "$WORK/late" ] && echo yes || echo no)"
kill -KILL -1
`;

/**
 * A gate writes `report/tests.json` through $FACTORY_GATE_RUN and runs long enough for the sampler (1 s here) to
 * fire in between the start and end samples; a cancelled gate is answered with the same files.
 */
const REPORTING = String.raw`
samples_ok() { grep -qE '^t=[0-9.]+ cpu=[0-9,]+ load=[0-9.]+ mem=[0-9]+/[0-9]+' "$box/done/$1/report/resources"; }
post a 'echo "{\"files\":[]}" > "$FACTORY_GATE_RUN/report/tests.json"; n=0; while [ $(wc -l < "$FACTORY_GATE_RUN/report/resources") -lt 3 ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n + 1)); done; echo A'
waitfor "[ -e $box/done/a/exit ]"
echo "a exit=$(cat $box/done/a/exit)"
echo "a report=$([ -s $box/done/a/report/tests.json ] && echo kept || echo lost)"
echo "a samples-ok=$(samples_ok a && echo yes || echo no)"
echo "a periodic=$([ "$(wc -l < $box/done/a/report/resources)" -ge 4 ] && echo yes || echo no)"
post b 'echo "{}" > "$FACTORY_GATE_RUN/report/tests.json"; sleep 30'
waitfor "[ -s $box/running/b/pgid ] && [ -s $box/running/b/report/tests.json ]"
touch "$box/running/b/cancel"
waitfor "[ -e $box/done/b/exit ]"
echo "b exit=$(cat $box/done/b/exit)"
echo "b report=$([ -s $box/done/b/report/tests.json ] && echo kept || echo lost)"
echo "b samples-ok=$(samples_ok b && echo yes || echo no)"
before=$(wc -l < $box/done/b/report/resources)
nap 2.5
echo "samples-after=$([ "$before" = "$(wc -l < $box/done/b/report/resources)" ] && echo same || echo grew)"
kill -KILL -1
`;

/** Two requests where the first is slow: without `setsid` the second is not taken until the first is answered. */
const SERIAL = String.raw`
post a 'sleep 1.5; echo A'
post b 'echo B'
waitfor "[ -d $box/running/a ]"
nap 0.6
echo "waiting=$(ls $box/requests | tr '\n' ' ')"
waitfor "[ -e $box/done/a/exit ] && [ -e $box/done/b/exit ]"
echo "a=$(cat $box/done/a/exit) b=$(cat $box/done/b/exit)"
kill -KILL -1
`;

describe.skipIf(!NAMESPACED)('the gate loop, run in a pid namespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-loop-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /** The harness's stdout: `scenarios` posted to a loop running `loop`, in a mailbox and a pid namespace of their own. */
    const run = (loop: string, scenarios: string, name: string): string => {
        const harness = join(dir, `${name}.sh`);
        writeFileSync(harness, PRELUDE + scenarios);
        const result = spawnSync('unshare', ['-Upf', 'sh', harness], {
            env: {
                PATH: process.env.PATH ?? '',
                FACTORY_GATE_SAMPLE_SECONDS: '1',
                BOX: join(dir, name),
                WORK: join(dir, 'work'),
                LOOP_SCRIPT: loop,
            },
            encoding: 'utf8',
            timeout: 60_000,
        });
        return result.stdout;
    };

    it('runs requests together, cancels one without touching the others, and sweeps when it is alone', () => {
        const out = run(gateLoopScript, SCENARIOS, 'parallel');
        expect(out).toContain('parallel=yes');
        expect(out).toContain('both ran at once');
        expect(out).toContain('a exit=0 out=A');
        expect(out).toContain('b exit=0 out=B');
        expect(out).toContain('d still running when c was answered: yes');
        expect(out).toContain('c exit=137 out=');
        expect(out).not.toContain('C-survived');
        expect(out).toContain('d exit=0 out=D');
        expect(out).toContain('h taken while g runs: no');
        expect(out).toContain('h exit=0 out=H');
        expect(out).toContain('e exit=137');
        expect(out).toContain('f exit=0 out=F');
        expect(out).toContain('late=no');
        expect(out).not.toContain('TIMEOUT');
    });

    it('keeps what a gate writes to its report directory, and samples the guest at start, during and at the end', () => {
        const out = run(gateLoopScript, REPORTING, 'reporting');
        expect(out).toContain('a exit=0');
        expect(out).toContain('a report=kept');
        expect(out).toContain('a samples-ok=yes');
        expect(out).toContain('a periodic=yes');
        // A cancelled gate answers with what it had written so far, and its samples.
        expect(out).toContain('b exit=137');
        expect(out).toContain('b report=kept');
        expect(out).toContain('b samples-ok=yes');
        // No sampler outlives its request.
        expect(out).toContain('samples-after=same');
        expect(out).not.toContain('TIMEOUT');
    });

    it('takes one request at a time, and offers no parallel, without setsid', () => {
        const withoutSetsid = gateLoopScript.replace(
            '/usr/bin/setsid /bin/setsid /usr/sbin/setsid /sbin/setsid',
            '/nonexistent/setsid'
        );
        expect(withoutSetsid).not.toBe(gateLoopScript);
        const out = run(withoutSetsid, SERIAL, 'serial');
        expect(out).toContain('parallel=no');
        expect(out).toContain('waiting=b');
        expect(out).toContain('a=0 b=0');
    });
});
