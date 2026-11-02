export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'component' | 'variable' | 'store' | 'composable' | 'handler';
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
}

export interface ExtractedRoute {
  side: 'client' | 'server';
  method?: string;
  path: string;
  name?: string;
  handler?: string;
  /** Import specifier of the component/handler module, resolved later by the indexer. */
  targetSpecifier?: string;
  line: number;
}

export interface ExtractedHttpCall {
  method?: string;
  url: string;
  line: number;
}

export interface ExtractedStore {
  name: string;
  line: number;
  actions: string[];
}

export interface FileAnalysis {
  lang: string;
  symbols: ExtractedSymbol[];
  imports: string[];
  routes: ExtractedRoute[];
  httpCalls: ExtractedHttpCall[];
  stores: ExtractedStore[];
  /** Tags used in templates/JSX — used for component edges by name. */
  usedComponents: string[];
  /** Client-side navigation targets found in templates / router.push calls. */
  navigations: string[];
}

export interface LanguageAdapter {
  id: string;
  extensions: string[];
  analyze(path: string, text: string): FileAnalysis;
}

export function emptyAnalysis(lang: string): FileAnalysis {
  return { lang, symbols: [], imports: [], routes: [], httpCalls: [], stores: [], usedComponents: [], navigations: [] };
}
