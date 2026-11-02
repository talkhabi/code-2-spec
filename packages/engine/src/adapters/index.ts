import { tsJsAdapter } from './ts-js.js';
import { vueAdapter } from './vue.js';
import type { LanguageAdapter } from './types.js';

/** Registered language adapters. Supporting a new language = add an adapter here. */
export const ADAPTERS: LanguageAdapter[] = [tsJsAdapter, vueAdapter];

export function adapterFor(path: string): LanguageAdapter | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ADAPTERS.find((a) => a.extensions.includes(ext));
}

export const SUPPORTED_EXTENSIONS = ADAPTERS.flatMap((a) => a.extensions);

export * from './types.js';
