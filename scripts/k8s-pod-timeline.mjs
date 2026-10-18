#!/usr/bin/env node
// The pods a kind lane run started, as kubelet saw them: `kubectl get events -o json` on stdin, one
// TSV row per image a pod's container used, every time in seconds since <since>. Built from events,
// not pods, so a pod the run already deleted still shows.
//
//   kubectl get events -n <ns> -o json | node scripts/k8s-pod-timeline.mjs <since ISO> <pod name regex>
//
// Stated limit: events carry second resolution, and a namespace shared with another release's
// runners can match the regex inside the window.
import { readFileSync } from 'node:fs';

const [since, pattern] = process.argv.slice(2);
if (!since || !pattern) {
    console.error('usage: k8s-pod-timeline.mjs <since ISO> <pod name regex>');
    process.exit(2);
}
const origin = Date.parse(since);
const match = new RegExp(pattern);

/** Go's duration string (`1m2.5s`, `850ms`) in seconds; '' when none. */
const goSeconds = (text) => {
    const units = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6 };
    let total = 0;
    for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|h|m|s)/g)) total += Number(n) * units[unit];
    return Number(total.toFixed(3));
};

const at = (event) => Date.parse(event.firstTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp ?? '');
const pods = new Map();
for (const event of JSON.parse(readFileSync(0, 'utf8')).items ?? []) {
    const object = event.involvedObject ?? {};
    const when = at(event);
    if (object.kind !== 'Pod' || !match.test(object.name ?? '') || !(when >= origin)) continue;
    const pod = pods.get(object.name) ?? { scheduled: '', started: '', images: [] };
    const offset = Math.round((when - origin) / 1000);
    const message = event.message ?? '';
    if (event.reason === 'Scheduled' && pod.scheduled === '') pod.scheduled = offset;
    if (event.reason === 'Started' && (pod.started === '' || offset < pod.started)) pod.started = offset;
    if (event.reason === 'Pulled') {
        const image = /image "([^"]+)"/.exec(message)?.[1] ?? '';
        const pulled = /Successfully pulled image "[^"]+" in (\S+)/.exec(message);
        pod.images.push({ image, at: offset, pull: pulled ? goSeconds(pulled[1]) : 'present' });
    }
    pods.set(object.name, pod);
}

const rows = [...pods].flatMap(([name, pod]) =>
    (pod.images.length > 0 ? pod.images : [{ image: '', at: '', pull: '' }]).map((image) => [
        name,
        image.image,
        pod.scheduled,
        image.at,
        image.pull,
        pod.started,
    ])
);
rows.sort((a, b) => (a[2] === '' ? Infinity : a[2]) - (b[2] === '' ? Infinity : b[2]) || (a[3] || 0) - (b[3] || 0));
process.stdout.write(
    ['pod\timage\tscheduled\tpulled_at\tpull_seconds\tstarted', ...rows.map((row) => row.join('\t'))].join('\n') + '\n'
);
