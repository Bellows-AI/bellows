import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';

const hasFiles = (e: DragEvent<HTMLElement>) => e.dataTransfer.types.includes('Files');

/**
 * The page-level guard, mounted once at the app shell: a file dropped outside every zone must not
 * make the browser open it and leave the page (and the draft on it). It only cancels the default;
 * nothing attaches outside a zone. Text and link drags carry no `Files` and are left alone.
 */
export function useFileDropGuard(): void {
    useEffect(() => {
        const guard = (e: globalThis.DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
        };
        window.addEventListener('dragover', guard);
        window.addEventListener('drop', guard);
        return () => {
            window.removeEventListener('dragover', guard);
            window.removeEventListener('drop', guard);
        };
    }, []);
}

/**
 * A region that takes dropped files anywhere inside it. While files are dragged over it a
 * "Drop files to attach" overlay shows; the enter/leave counter keeps the overlay steady as the
 * pointer crosses child elements. `accepts` is asked at the moment of the drag, so a zone with no
 * composer behind it (or a board without attachments) leaves the browser's default alone.
 */
export function AttachmentDropZone({
    className,
    accepts,
    onFiles,
    children,
}: {
    className: string;
    accepts: () => boolean;
    onFiles: (files: File[]) => void;
    children: ReactNode;
}) {
    const depth = useRef(0);
    const [over, setOver] = useState(false);
    const reset = () => {
        depth.current = 0;
        setOver(false);
    };
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop has no keyboard form; the Attach button is the accessible path.
        <div
            className={over ? `${className} drop-zone is-dragging` : `${className} drop-zone`}
            onDragEnter={(e) => {
                if (!hasFiles(e) || !accepts()) return;
                depth.current += 1;
                setOver(true);
            }}
            onDragOver={(e) => {
                if (hasFiles(e) && accepts()) e.preventDefault();
            }}
            onDragLeave={(e) => {
                if (!hasFiles(e) || depth.current === 0) return;
                depth.current -= 1;
                if (depth.current === 0) setOver(false);
            }}
            onDrop={(e) => {
                if (!hasFiles(e) || !accepts()) return;
                e.preventDefault();
                reset();
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) onFiles(files);
            }}
        >
            {children}
            {over ? (
                <div className="drop-overlay" aria-hidden="true">
                    Drop files to attach
                </div>
            ) : null}
        </div>
    );
}
