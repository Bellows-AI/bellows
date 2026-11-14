/** A kubernetes quantity pair side, in the chart's own `resources` shape. */
type ResourceList = { cpu?: string; memory?: string };
type Resources = { requests?: ResourceList; limits?: ResourceList };

/** A driver env declaring one runner class, `default` (the implicit default's name), carrying `fields`. */
export const oneClass = (fields: Record<string, unknown>): Record<string, string> => ({
    RUNNER_CLASSES: JSON.stringify({ default: fields }),
});

/** A driver env whose one class is sized by `resources`, and its gate by `gateResources` over them. */
export const sized = (resources: Resources, gateResources?: Resources): Record<string, string> =>
    oneClass({ resources, ...(gateResources ? { gateResources } : {}) });
