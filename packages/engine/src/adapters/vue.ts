import { parse } from '@vue/compiler-sfc';
import { ScriptKind } from 'ts-morph';
import { analyzeScript } from './ts-js.js';
import { emptyAnalysis, type LanguageAdapter } from './types.js';

export const vueAdapter: LanguageAdapter = {
  id: 'vue',
  extensions: ['vue'],
  analyze(path, text) {
    const out = emptyAnalysis('vue');
    const { descriptor } = parse(text, { filename: path, sourceMap: false });
    const name = path.split('/').pop()!.replace(/\.vue$/, '');
    const totalLines = text.split('\n').length;
    out.symbols.push({ name, kind: 'component', startLine: 1, endLine: totalLines, exported: true });

    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const lang = block.lang ?? 'js';
      const kind = lang === 'tsx' ? ScriptKind.TSX : lang === 'jsx' ? ScriptKind.JSX : lang.startsWith('ts') ? ScriptKind.TS : ScriptKind.JS;
      analyzeScript(block.content, `${path}.${lang}`, out, block.loc.start.line - 1, kind);
    }

    const template = descriptor.template?.content;
    if (template) {
      const offset = descriptor.template!.loc.start.line - 1;
      for (const m of template.matchAll(/<([A-Z][\w]*|[a-z]+(?:-[a-z0-9]+)+)[\s/>]/g)) {
        const tag = m[1].includes('-') ? m[1].replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()) : m[1];
        if (!/^(RouterView|RouterLink|Transition|KeepAlive|Teleport|Suspense|Component)$/.test(tag)) out.usedComponents.push(tag);
      }
      for (const m of template.matchAll(/<(?:router-link|RouterLink|nuxt-link|NuxtLink)[^>]*?\sto="([^"]+)"/g)) out.navigations.push(m[1]);
      // template event handlers point the AI at UI entry points of flows
      const lines = template.split('\n');
      lines.forEach((l, i) => {
        for (const m of l.matchAll(/(?:@|v-on:)([\w.-]+)="([^"]{1,80})"/g)) {
          out.symbols.push({ name: `@${m[1]} → ${m[2]}`, kind: 'handler', startLine: offset + i + 1, endLine: offset + i + 1, exported: false });
        }
      });
    }
    out.usedComponents = [...new Set(out.usedComponents)];
    return out;
  },
};
