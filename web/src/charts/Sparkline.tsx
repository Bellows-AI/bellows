const WIDTH = 200;
const HEIGHT = 32;
/** Keeps the stroke inside the box at the top and bottom edges. */
const INSET = 2;

/**
 * A decorative trend line under a figure. The figure beside it is the content; each point
 * still names its bucket and value in a native tooltip. A partial last bucket draws dashed,
 * because its value is still filling.
 */
export function Sparkline({
    values,
    labels,
    partialLast,
}: {
    values: readonly number[];
    labels: readonly string[];
    partialLast: boolean;
}) {
    if (values.length < 2) return null;
    const max = Math.max(1, ...values);
    const step = WIDTH / (values.length - 1);
    const points = values.map((v, i) => [i * step, HEIGHT - INSET - (v / max) * (HEIGHT - 2 * INSET)] as const);
    const path = (pts: readonly (readonly [number, number])[]) => `M${pts.map(([x, y]) => `${x},${y}`).join(' L')}`;
    const solid = partialLast ? points.slice(0, -1) : points;
    return (
        <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            <path className="sparkline-area" d={`${path(points)} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`} />
            <path className="sparkline-line" d={path(solid)} vectorEffect="non-scaling-stroke" />
            {partialLast ? (
                <path
                    className="sparkline-line sparkline-partial"
                    d={path(points.slice(-2))}
                    vectorEffect="non-scaling-stroke"
                />
            ) : null}
            {points.map(([x], i) => (
                <rect key={labels[i]} className="sparkline-hit" x={x - step / 2} y={0} width={step} height={HEIGHT}>
                    <title>{`${labels[i]} · ${values[i]}`}</title>
                </rect>
            ))}
        </svg>
    );
}
