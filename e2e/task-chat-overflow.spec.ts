import { expect, test } from '@playwright/test';
import { authoredBy, longChatThread, routeThread, sessionAuthor } from './fixtures/threads.js';
import { noHorizontalOverflow } from './viewport.js';
import { watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

/** The task chat holds the viewport at every size: a URL, a code line, a pipe table and an
 *  unbroken token wrap, or scroll inside their own block — never the conversation or the page. */
for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['tablet', 768, 1000],
    ['phone', 360, 740],
] as const) {
    test(`the task chat stays inside the ${name} viewport with long unbroken content`, async ({ page }) => {
        const problems = watchConsole(page);
        await routeThread(page, authoredBy(longChatThread, await sessionAuthor(page)));
        await page.setViewportSize({ width, height });
        await page.goto(`/tasks/${longChatThread[0]!.id}`);

        const conversation = page.getByRole('region', { name: 'Conversation' });
        await expect(conversation.getByLabel('Run 1')).toBeVisible();
        await expect(conversation.getByLabel('Run 2')).toBeVisible();

        const { scroll, client } = await conversation.evaluate((el) => ({
            scroll: el.scrollWidth,
            client: el.clientWidth,
        }));
        expect(scroll, `${name}: the chat scrolls horizontally`).toBeLessThanOrEqual(client);
        await noHorizontalOverflow(page);

        // Nothing inside the chat reaches past it, except inside a block that scrolls on its own.
        const escapes = await conversation.evaluate((root) => {
            const edge = root.getBoundingClientRect().right + 1;
            const out: string[] = [];
            for (const el of root.querySelectorAll<HTMLElement>('*')) {
                if (el.closest('.chat-output, .run-well, pre')) continue;
                const box = el.getBoundingClientRect();
                if (box.width > 0 && box.right > edge) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
            }
            return out;
        });
        expect(escapes, `${name}: elements reaching past the chat`).toEqual([]);

        await page.screenshot({ path: `${SHOTS}/task-chat-overflow-${name}.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
}
