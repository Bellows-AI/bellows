import type { ExecutorType } from '@factory-ai/core';
import { executorTypeLabel } from '../workspace/executors.js';

/** The model names a family can be read from: Claude's tiers, the other catalogs' marques, and GPT's versions. */
const FAMILIES = /(sonnet|opus|haiku|gemini|kimi|qwen|gpt-[\d.]+(?:-codex|-mini)?)/i;

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The family a model id belongs to, for naming an executor: `claude-sonnet-5-5` and `anthropic/claude-sonnet-5.5` are
 * Sonnet, `openai/gpt-5.1-codex` is GPT-5.1 Codex; an id with no known family is itself, without its provider prefix.
 */
export function modelFamily(model: string): string {
    const id = model.trim().split('/').pop() ?? '';
    const found = FAMILIES.exec(id)?.[1]?.toLowerCase();
    if (!found) return id;
    const [head = '', ...rest] = found.split('-');
    if (head !== 'gpt') return capital(found);
    const [version = '', ...tags] = rest;
    return ['GPT-' + version, ...tags.map(capital)].join(' ');
}

/** The executor name the card offers until the member edits it: `<Agent> · <Model family>`, the agent alone without a model. */
export function generatedExecutorName(agent: ExecutorType, model: string): string {
    const family = modelFamily(model);
    return family === '' ? executorTypeLabel(agent) : `${executorTypeLabel(agent)} · ${family}`;
}
