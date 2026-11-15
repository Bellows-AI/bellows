import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface MatrixImage {
    name: string;
    context: string;
    args: string;
}

interface Release {
    jobs: Record<string, { strategy?: { matrix?: { image?: MatrixImage[] } }; steps?: { run?: string }[] }>;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const release = () => parse(read('.github/workflows/release-image.yml')) as Release;
const matrixImages = () => Object.values(release().jobs).flatMap((job) => job.strategy?.matrix?.image ?? []);
// The step that joins each image's two arch tags into one multi-arch tag.
const manifestLoop = () =>
    Object.values(release().jobs)
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.run ?? '')
        .find((run) => run.includes('imagetools create') && /^\s*for image in /m.test(run));

// The dev runner image is what this repository's `.bellows.yaml` names: it ships with every release,
// for both arches, under the same tag as the other images.
describe('the release builds the dev runner image', () => {
    it('lists it in the build matrix, built from its own directory', () => {
        const entry = matrixImages().find((image) => image.name === 'dev-runner');
        expect(entry).toBeDefined();
        expect(entry!.context).toBe('docker/dev-runner');
    });

    it('joins its two arch tags in the manifest loop, with every other matrix image', () => {
        const loop = manifestLoop();
        expect(loop).toBeDefined();
        const names = /^\s*for image in ([^;]+);/m.exec(loop!)![1]!.trim().split(/\s+/);
        expect(names).toContain('dev-runner');
        expect([...names].sort()).toEqual(
            matrixImages()
                .map((image) => image.name)
                .sort()
        );
    });

    it('keeps its base digest in the weekly re-pin', () => {
        expect(read('scripts/pin-digests.sh')).toMatch(/^for file in .*docker\/dev-runner\/Dockerfile/m);
    });
});
