import { runWithSqlite } from './runtime.js';

await runWithSqlite(() => import('./cli-main.js'));
