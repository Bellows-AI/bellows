/**
 * The specimen grid's axes (redesign plan §1.7), spelled once: the page renders them as its row
 * and column headers, and the spec asserts every one is on screen, so a row cannot be dropped
 * from the page without the check noticing.
 */
export const COLUMNS = ['Default', 'Selected', 'Invalid', 'Disabled', 'Busy', 'Long content'] as const;

export type Column = (typeof COLUMNS)[number];

export const ROWS = [
    'Primary button',
    'Secondary button',
    'Destructive button',
    'Tertiary button',
    'Icon button',
    'Tabs',
    'Row actions',
    'Selector (closed)',
    'Selector (open)',
    'Text field',
    'Textarea',
    'Checkbox',
    'Switch',
    'Filter chip',
    'Table row',
    'Pill',
    'Avatar',
    'Kbd',
    'Banner (warn)',
    'Banner (bad)',
    'Banner (info)',
    'Dialog',
    'Disclosure (closed)',
    'Disclosure (open)',
] as const;

export type Row = (typeof ROWS)[number];

/** The sheet's sections over the grid: each names the first row it covers, in ROWS order. */
export const GROUPS = [
    ['Actions', 'Primary button'],
    ['Forms', 'Selector (closed)'],
    ['Data', 'Table row'],
    ['Feedback', 'Banner (warn)'],
] as const satisfies readonly (readonly [string, Row])[];

/** Every section the sheet shows, in page order; the spec asserts each is a heading on screen. */
export const SECTIONS = ['Surfaces', 'Type', 'Icons', 'Actions', 'Data', 'Forms', 'States', 'Tokens'] as const;

/** A cell's `data-cell` id: the page stamps it, the spec finds its targets by it. */
export const cellId = (row: Row, column: Column) => `${row}/${column}`;

/** Sixty characters with no break opportunity: what a primitive does with a label it cannot wrap. */
export const LONG_LABEL = 'W'.repeat(60);

/** The organization the open-selector row's trigger names; the spec clicks it by this name. */
export const OPEN_SELECTOR_ORG = 'Acme Robotics';

/** The usage-component states, spelled once like the grid's axes: the page renders each, the spec asserts each. */
export const USAGE_STATES = [
    'Measured',
    'Unmeasured',
    'Measured zero',
    'Estimated',
    'Partial coverage',
    'Provisional',
    'Unavailable',
    'Breakdown collapsed',
    'Breakdown expanded',
    'Diagnostics',
] as const;

export type UsageState = (typeof USAGE_STATES)[number];

export const usageCellId = (state: UsageState) => `Usage/${state}`;
