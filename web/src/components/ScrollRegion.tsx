import type { ElementType, ReactNode, Ref } from 'react';

/**
 * A region that scrolls. It is keyboard-focusable, or its overflow is unreachable without a
 * pointer, so it carries `tabIndex={0}` and the label that names it. This is the one place that
 * says so: the 11 hand-copied `tabIndex` wrappers (each with a lint ignore) are this component.
 * `as="pre"` is the log well; the default is a labelled `section` around a table.
 */
export function ScrollRegion({
    as = 'section',
    className,
    ref,
    children,
    ...label
}: {
    as?: 'section' | 'pre';
    className: string;
    ref?: Ref<HTMLPreElement> | undefined;
    children: ReactNode;
} & ({ 'aria-label': string } | { 'aria-labelledby': string } | { 'aria-label'?: undefined })) {
    const Tag: ElementType = as;
    return (
        <Tag className={className} tabIndex={0} ref={ref} {...label}>
            {children}
        </Tag>
    );
}
