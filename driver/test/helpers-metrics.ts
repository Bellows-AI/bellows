import type { Meter } from '@opentelemetry/api';
import {
    MeterProvider,
    MetricReader,
    type DataPoint,
    type Histogram,
    type MetricData,
} from '@opentelemetry/sdk-metrics';

/** A reader that exports nothing and is collected on demand, so a test reads what an SDK would have shipped. */
class CollectingReader extends MetricReader {
    protected onShutdown(): Promise<void> {
        return Promise.resolve();
    }
    protected onForceFlush(): Promise<void> {
        return Promise.resolve();
    }
}

type Points = DataPoint<number | Histogram>[];

/** The data points of one instrument in a collection; empty when it reported none. */
export const pointsIn = (collected: MetricData[], name: string): Points =>
    (collected.find((m) => m.descriptor.name === name)?.dataPoints ?? []) as Points;

export interface MetricsHarness {
    meter: Meter;
    /** Every instrument with its data points, as a collection now would export them. */
    collect(): Promise<MetricData[]>;
    /** The data points of one instrument; empty when it reported none. */
    points(name: string): Promise<Points>;
}

export function metricsHarness(): MetricsHarness {
    const reader = new CollectingReader();
    const provider = new MeterProvider({ readers: [reader] });
    const collect = async (): Promise<MetricData[]> => {
        const { resourceMetrics } = await reader.collect();
        return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    };
    return {
        meter: provider.getMeter('test'),
        collect,
        points: async (name) => pointsIn(await collect(), name),
    };
}

/** The value of the data point carrying exactly these attributes, or undefined. */
export const countOf = (points: Points, attributes: Record<string, string | number>) => {
    const point = points.find(
        (p) =>
            Object.keys(p.attributes).length === Object.keys(attributes).length &&
            Object.entries(attributes).every(([key, value]) => p.attributes[key] === value)
    );
    return point && (typeof point.value === 'number' ? point.value : point.value.count);
};
