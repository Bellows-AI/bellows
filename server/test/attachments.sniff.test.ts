import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { sniffAttachment } from '../src/attachments/sniff.js';
import { docxBytes, jpegBytes, pdfBytes, pngBytes, textBytes, webpBytes, zipBytes } from './helpers-attachments.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const typeOf = (bytes: Uint8Array, hints?: { name?: string; mediaType?: string }) => {
    const result = sniffAttachment(bytes, hints);
    return result.ok ? result.mediaType : result.reason;
};

describe('sniffAttachment', () => {
    it('accepts PNG, JPEG, WebP and PDF by their signatures', () => {
        expect(typeOf(pngBytes())).toBe('image/png');
        expect(typeOf(jpegBytes())).toBe('image/jpeg');
        expect(typeOf(webpBytes())).toBe('image/webp');
        expect(typeOf(pdfBytes())).toBe('application/pdf');
    });

    it('accepts a DOCX only as a ZIP whose central directory names its two parts', () => {
        expect(typeOf(docxBytes())).toBe(DOCX);
        expect(typeOf(zipBytes(['[Content_Types].xml']))).toBe('unsupported');
        expect(typeOf(zipBytes(['word/document.xml']))).toBe('unsupported');
        expect(typeOf(zipBytes(['a.txt', 'b.txt']))).toBe('unsupported');
    });

    it('refuses a macro-enabled document', () => {
        expect(typeOf(docxBytes(['word/vbaProject.bin']))).toBe('unsupported');
    });

    it('refuses a truncated ZIP', () => {
        expect(typeOf(docxBytes().slice(0, 40))).toBe('unsupported');
    });

    it('accepts TXT, MD and CSV only as NUL-free UTF-8', () => {
        expect(typeOf(textBytes('hello'), { name: 'a.txt' })).toBe('text/plain');
        expect(typeOf(textBytes('# title'), { name: 'a.md' })).toBe('text/markdown');
        expect(typeOf(textBytes('a,b\n1,2'), { name: 'a.csv' })).toBe('text/csv');
        expect(typeOf(textBytes('no name'))).toBe('text/plain');
        expect(typeOf(Uint8Array.from([0x68, 0x00, 0x69]), { name: 'a.txt' })).toBe('unsupported');
        expect(typeOf(Uint8Array.from([0xff, 0xfe, 0xfd]), { name: 'a.txt' })).toBe('unsupported');
    });

    it('ignores the declared name and decides from the bytes', () => {
        expect(typeOf(pngBytes(), { name: 'photo.pdf' })).toBe('image/png');
        expect(typeOf(pdfBytes(), { name: 'notes.txt' })).toBe('application/pdf');
    });

    it('refuses a declared media type that is not the sniffed one', () => {
        expect(typeOf(pngBytes(), { mediaType: 'application/pdf' })).toBe('mismatch');
        expect(typeOf(pngBytes(), { mediaType: 'image/png' })).toBe('image/png');
    });

    it('refuses SVG, HTML, ZIP and executables', () => {
        expect(typeOf(textBytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), { name: 'a.txt' })).toBe('unsupported');
        expect(typeOf(textBytes('<?xml version="1.0"?><svg/>'))).toBe('unsupported');
        expect(typeOf(textBytes('  <!DOCTYPE html><html></html>'))).toBe('unsupported');
        expect(typeOf(textBytes('<HTML><script>x</script>'))).toBe('unsupported');
        expect(typeOf(textBytes('<!-- a --> \n<!--b--><svg/>'))).toBe('unsupported');
        expect(typeOf(zipBytes(['a.txt']))).toBe('unsupported');
        expect(typeOf(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBe('unsupported');
        expect(typeOf(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]))).toBe('unsupported');
    });

    it('refuses an empty body', () => {
        expect(typeOf(new Uint8Array())).toBe('malformed');
    });

    it('refuses image headers declaring a side or an area over the limits', () => {
        expect(typeOf(pngBytes(MAX_IMAGE_SIDE + 1, 1))).toBe('image-too-large');
        expect(typeOf(jpegBytes(1, MAX_IMAGE_SIDE + 1))).toBe('image-too-large');
        expect(typeOf(webpBytes(MAX_IMAGE_SIDE + 1, 1))).toBe('image-too-large');
        const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
        expect(side).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
        expect(typeOf(pngBytes(side, side))).toBe('image-too-large');
        expect(typeOf(pngBytes(MAX_IMAGE_SIDE / 2, 1))).toBe('image/png');
    });

    it('refuses an image whose header is truncated', () => {
        expect(typeOf(pngBytes().slice(0, 12))).toBe('malformed');
        expect(typeOf(jpegBytes().slice(0, 6))).toBe('malformed');
        expect(typeOf(webpBytes().slice(0, 20))).toBe('malformed');
        expect(typeOf(pngBytes(0, 4))).toBe('malformed');
    });
});
