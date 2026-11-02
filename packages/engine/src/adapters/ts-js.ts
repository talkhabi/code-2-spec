import { Project as TsProject, Node, SyntaxKind, ScriptKind, type SourceFile, type ObjectLiteralExpression, type CallExpression } from 'ts-morph';
import { emptyAnalysis, type FileAnalysis, type LanguageAdapter } from './types.js';

const tsProject = new TsProject({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: 1 /* preserve */ },
});

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options', 'all']);
const SERVER_RECEIVER = /^(app|router|server|api|r|route|routes|fastify|koa|instance)$|router$/i;
const CLIENT_RECEIVER = /^(axios|http|\$http|client|request|api|\$api|ky|fetcher|apiClient|httpClient|service|\$axios|this\.\$http|this\.\$axios|instance)$/i;
const NEST_METHODS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', All: 'ALL', Head: 'HEAD', Options: 'OPTIONS' };

export function scriptKindFor(path: string): ScriptKind {
  if (path.endsWith('.tsx')) return ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ScriptKind.JS;
  return ScriptKind.TS;
}

/** Analyze a JS/TS source text. `lineOffset` maps lines back to the original file (used for Vue SFC script blocks). */
export function analyzeScript(text: string, path: string, out: FileAnalysis, lineOffset = 0, kind = scriptKindFor(path)) {
  const sf = tsProject.createSourceFile(`/virtual/${out.symbols.length}-${path.replace(/[^\w.]/g, '_')}`, text, { overwrite: true, scriptKind: kind });
  try {
    collect(sf, out, lineOffset);
  } finally {
    tsProject.removeSourceFile(sf);
  }
}

function collect(sf: SourceFile, out: FileAnalysis, off: number) {
  const line = (n: Node) => n.getStartLineNumber() + off;
  const endLine = (n: Node) => n.getEndLineNumber() + off;
  const importNames = new Map<string, string>(); // local identifier -> module specifier

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    out.imports.push(spec);
    const def = imp.getDefaultImport();
    if (def) importNames.set(def.getText(), spec);
    for (const n of imp.getNamedImports()) importNames.set((n.getAliasNode() ?? n.getNameNode()).getText(), spec);
  }
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init) && init.getExpression().getText() === 'require') {
      const arg = init.getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) importNames.set(decl.getName(), arg.getLiteralValue());
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec) out.imports.push(spec);
  }

  // top-level declarations
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? 'default';
    out.symbols.push({
      name, kind: name.startsWith('use') ? 'composable' : 'function', startLine: line(fn), endLine: endLine(fn),
      exported: fn.isExported(), signature: signatureOf(fn.getText()),
    });
  }
  for (const cls of sf.getClasses()) {
    const name = cls.getName() ?? 'default';
    out.symbols.push({ name, kind: 'class', startLine: line(cls), endLine: endLine(cls), exported: cls.isExported() });
    for (const m of cls.getMethods()) {
      out.symbols.push({ name: `${name}.${m.getName()}`, kind: 'method', startLine: line(m), endLine: endLine(m), exported: cls.isExported(), signature: signatureOf(m.getText()) });
    }
  }
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const name = decl.getName();
      let kind: FileAnalysis['symbols'][number]['kind'] | undefined;
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) kind = name.startsWith('use') ? 'composable' : 'function';
      else if (Node.isCallExpression(init)) {
        const callee = init.getExpression().getText();
        if (/defineStore|createSlice|createStore/.test(callee)) kind = 'store';
        else if (/defineComponent|defineAsyncComponent|forwardRef|memo/.test(callee)) kind = 'component';
      } else if (Node.isObjectLiteralExpression(init) && init.getProperty('actions')) kind = 'store';
      if (kind) out.symbols.push({ name, kind, startLine: line(decl), endLine: endLine(decl), exported: stmt.isExported(), signature: signatureOf(decl.getText()) });
    }
  }

  // Options API / object default export: capture methods as handlers
  const defaultExport = sf.getExportAssignment((e) => !e.isExportEquals());
  if (defaultExport) {
    let expr: Node = defaultExport.getExpression();
    if (Node.isCallExpression(expr) && expr.getArguments()[0]) expr = expr.getArguments()[0];
    if (Node.isObjectLiteralExpression(expr)) {
      for (const section of ['methods', 'actions', 'mutations', 'computed', 'watch']) {
        const prop = expr.getProperty(section);
        const obj = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
        if (obj && Node.isObjectLiteralExpression(obj)) {
          for (const p of obj.getProperties()) {
            const pName = Node.isMethodDeclaration(p) || Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : undefined;
            if (pName) out.symbols.push({ name: `${section}.${pName}`, kind: 'handler', startLine: line(p), endLine: endLine(p), exported: true, signature: signatureOf(p.getText()) });
          }
        }
      }
    }
  }

  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) handleCall(node, out, importNames, line);
    else if (Node.isObjectLiteralExpression(node)) handleObject(node, out, importNames, line);
    else if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
      const tag = node.getTagNameNode().getText();
      if (/^[A-Z]/.test(tag)) out.usedComponents.push(tag);
      if (/^(Link|NavLink|RouterLink|NuxtLink)$/.test(tag)) {
        const to = node.getAttributes().find((a) => Node.isJsxAttribute(a) && /^(to|href)$/.test(a.getNameNode().getText()));
        const val = to && Node.isJsxAttribute(to) ? to.getInitializer() : undefined;
        if (val && Node.isStringLiteral(val)) out.navigations.push(val.getLiteralValue());
      }
    } else if (Node.isClassDeclaration(node)) handleNestController(node, out, line);
  });
}

function handleCall(node: CallExpression, out: FileAnalysis, importNames: Map<string, string>, line: (n: Node) => number) {
  const callee = node.getExpression();
  const args = node.getArguments();
  const calleeText = callee.getText();

  // require('x') / import('x')
  if ((calleeText === 'require' || callee.getKind() === SyntaxKind.ImportKeyword) && args[0] && Node.isStringLiteral(args[0])) {
    out.imports.push(args[0].getLiteralValue());
    return;
  }

  // fetch-style calls
  if (/^(fetch|\$fetch|useFetch|useLazyFetch|ofetch|window\.fetch|useAsyncData)$/.test(calleeText) && args[0]) {
    const url = urlText(args[0]);
    if (url) {
      let method: string | undefined;
      const opts = args[1];
      if (opts && Node.isObjectLiteralExpression(opts)) {
        const m = opts.getProperty('method');
        if (m && Node.isPropertyAssignment(m)) method = m.getInitializer()?.getText().replace(/['"`]/g, '').toUpperCase();
      }
      out.httpCalls.push({ method: method ?? 'GET', url, line: line(node) });
    }
    return;
  }

  // navigation
  if (/(^|\.)(\$?router)\.(push|replace)$|^navigateTo$/.test(calleeText) && args[0]) {
    const a = args[0];
    if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) out.navigations.push(a.getLiteralValue());
    else if (Node.isObjectLiteralExpression(a)) {
      const p = a.getProperty('name') ?? a.getProperty('path');
      if (p && Node.isPropertyAssignment(p)) out.navigations.push(p.getInitializer()?.getText().replace(/['"`]/g, '') ?? '');
    }
    return;
  }

  // stores
  if (/^defineStore$/.test(calleeText) && args[0]) {
    const name = Node.isStringLiteral(args[0]) ? args[0].getLiteralValue() : args[0].getText();
    const def = Node.isObjectLiteralExpression(args[0]) ? args[0] : args[1];
    out.stores.push({ name, line: line(node), actions: storeActions(def) });
    return;
  }
  if (/createSlice$/.test(calleeText) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const nameProp = args[0].getProperty('name');
    const name = nameProp && Node.isPropertyAssignment(nameProp) ? nameProp.getInitializer()?.getText().replace(/['"`]/g, '') ?? 'slice' : 'slice';
    out.stores.push({ name, line: line(node), actions: objectKeys(args[0], 'reducers') });
    return;
  }

  // HTTP verbs on a receiver: either server route registration or client HTTP call
  if (Node.isPropertyAccessExpression(callee)) {
    const verb = callee.getName().toLowerCase();
    const receiver = callee.getExpression().getText();
    if ((HTTP_VERBS.has(verb) || verb === 'request') && args[0]) {
      const url = urlText(args[0]);
      if (!url) return;
      const hasHandler = args.slice(1).some((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
      const isServer = verb !== 'request' && url.startsWith('/') && (hasHandler || (SERVER_RECEIVER.test(receiver) && !CLIENT_RECEIVER.test(receiver) && args.length >= 2));
      if (isServer) {
        const last = args[args.length - 1];
        const handler = Node.isIdentifier(last) || Node.isPropertyAccessExpression(last) ? last.getText() : undefined;
        const targetSpecifier = handler ? importNames.get(handler.split('.')[0]) : undefined;
        out.routes.push({ side: 'server', method: verb === 'del' ? 'DELETE' : verb.toUpperCase(), path: url, handler, targetSpecifier, line: line(node) });
      } else if (!/^(map|set|params|query|headers|localStorage|sessionStorage|cache|store|this\.\$store|searchParams|formData)$/i.test(receiver)) {
        out.httpCalls.push({ method: verb === 'request' ? undefined : verb.toUpperCase(), url, line: line(node) });
      }
    }
  }
}

function handleObject(node: ObjectLiteralExpression, out: FileAnalysis, importNames: Map<string, string>, line: (n: Node) => number) {
  const pathProp = node.getProperty('path');
  if (!pathProp || !Node.isPropertyAssignment(pathProp)) return;
  const pathInit = pathProp.getInitializer();
  if (!pathInit || !(Node.isStringLiteral(pathInit) || Node.isNoSubstitutionTemplateLiteral(pathInit))) return;
  const hasRouteShape = ['component', 'components', 'children', 'redirect', 'name', 'meta'].some((k) => node.getProperty(k));
  if (!hasRouteShape || !Node.isArrayLiteralExpression(node.getParent())) return;

  // full path including parent route paths (nested children)
  const segments = [pathInit.getLiteralValue()];
  let ancestor: Node | undefined = node.getParent()?.getParent();
  while (ancestor) {
    if (Node.isObjectLiteralExpression(ancestor)) {
      const p = ancestor.getProperty('path');
      const v = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
      if (v && Node.isStringLiteral(v)) segments.unshift(v.getLiteralValue());
    }
    ancestor = ancestor.getParent();
  }
  const fullPath = segments.reduce((acc, s) => (s.startsWith('/') ? s : `${acc.replace(/\/$/, '')}/${s}`), '');

  const nameProp = node.getProperty('name');
  const name = nameProp && Node.isPropertyAssignment(nameProp) ? nameProp.getInitializer()?.getText().replace(/['"`]/g, '') : undefined;
  let targetSpecifier: string | undefined;
  let handler: string | undefined;
  const compProp = node.getProperty('component');
  if (compProp && Node.isPropertyAssignment(compProp)) {
    const c = compProp.getInitializer();
    if (c) {
      handler = c.getText().slice(0, 120);
      if (Node.isIdentifier(c)) targetSpecifier = importNames.get(c.getText());
      else {
        const dyn = c.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword);
        const arg = dyn?.getArguments()[0];
        if (arg && Node.isStringLiteral(arg)) targetSpecifier = arg.getLiteralValue();
      }
    }
  }
  out.routes.push({ side: 'client', path: fullPath || '/', name, handler, targetSpecifier, line: line(node) });
}

function handleNestController(cls: import('ts-morph').ClassDeclaration, out: FileAnalysis, line: (n: Node) => number) {
  const ctrl = cls.getDecorator('Controller');
  if (!ctrl) return;
  const prefixArg = ctrl.getArguments()[0];
  const prefix = prefixArg && Node.isStringLiteral(prefixArg) ? prefixArg.getLiteralValue() : '';
  for (const m of cls.getMethods()) {
    for (const d of m.getDecorators()) {
      const method = NEST_METHODS[d.getName()];
      if (!method) continue;
      const a = d.getArguments()[0];
      const sub = a && Node.isStringLiteral(a) ? a.getLiteralValue() : '';
      const path = `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      out.routes.push({ side: 'server', method, path, handler: `${cls.getName()}.${m.getName()}`, line: line(m) });
    }
  }
}

function storeActions(def: Node | undefined): string[] {
  if (!def) return [];
  if (Node.isObjectLiteralExpression(def)) return objectKeys(def, 'actions');
  if (Node.isArrowFunction(def) || Node.isFunctionExpression(def)) {
    const ret = def.getDescendantsOfKind(SyntaxKind.ReturnStatement).at(-1)?.getExpression();
    if (ret && Node.isObjectLiteralExpression(ret)) {
      return ret.getProperties().map((p) => (Node.isShorthandPropertyAssignment(p) || Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) ? p.getName() : '')).filter(Boolean);
    }
  }
  return [];
}

function objectKeys(obj: ObjectLiteralExpression, prop: string): string[] {
  const p = obj.getProperty(prop);
  const init = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
  if (!init || !Node.isObjectLiteralExpression(init)) return [];
  return init.getProperties().map((x) => (Node.isMethodDeclaration(x) || Node.isPropertyAssignment(x) || Node.isShorthandPropertyAssignment(x) ? x.getName() : '')).filter(Boolean);
}

function urlText(node: Node, depth = 0): string | undefined {
  // URL held in a same-file constant: `const ENDPOINT = '/users'` → `http.get(ENDPOINT)`
  if (Node.isIdentifier(node) && depth < 3) {
    const init = node.getSourceFile().getVariableDeclaration(node.getText())?.getInitializer();
    return init ? urlText(init, depth + 1) : undefined;
  }
  if (Node.isAsExpression(node) && depth < 3) return urlText(node.getExpression(), depth + 1);
  let text: string | undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) text = node.getLiteralValue();
  else if (Node.isTemplateExpression(node)) {
    // inline same-file constants (`${BASE}/users/${id}` → /api/users/{id})
    const part = (e: Node) => (Node.isIdentifier(e) && depth < 3 ? urlText(e, depth + 1) : undefined) ?? `{${e.getText().split('.').pop()}}`;
    text = node.getHead().getLiteralText() + node.getTemplateSpans().map((s) => `${part(s.getExpression())}${s.getLiteral().getLiteralText()}`).join('');
  } else if (Node.isBinaryExpression(node)) {
    text = node.getText().replace(/\s+/g, ' ');
  }
  if (!text) return undefined;
  if (text.startsWith('/') || /^https?:/.test(text) || /^[\w{}$.-]+\/[\w{}/:.-]*/.test(text)) return text.slice(0, 300);
  return undefined;
}

function signatureOf(text: string): string {
  const firstLine = text.split('\n')[0];
  return firstLine.replace(/\s*\{?\s*$/, '').slice(0, 200);
}

export const tsJsAdapter: LanguageAdapter = {
  id: 'ts-js',
  extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
  analyze(path, text) {
    const out = emptyAnalysis(/\.tsx?$|\.[mc]ts$/.test(path) ? 'typescript' : 'javascript');
    analyzeScript(text, path, out);
    return out;
  },
};
