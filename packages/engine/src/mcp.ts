import { runWithSqlite } from './runtime.js';

await runWithSqlite(() => import('./mcp-main.js'));
