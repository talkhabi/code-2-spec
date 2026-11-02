import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, RunUsage } from './runner.js';
import { invokeTool, type TaskContext, type ToolDef } from './tools.js';
import type { TaskPrompt } from './prompts.js';

const SERVER = 'code2spec';

/**
 * Runs agents through the Claude Agent SDK. Auth comes from ANTHROPIC_API_KEY or an existing Claude Code login.
 * The agent gets no built-in tools, only the code2spec tools bound to this task (which refuse secret files).
 */
export class ClaudeAgentSdkRunner implements AgentRunner {
  readonly name = 'claude-agent-sdk';

  constructor(private opts: { model?: string; maxTurns?: number } = {}) {}

  async run(task: TaskPrompt, tools: ToolDef[], ctx: TaskContext, signal?: AbortSignal): Promise<RunUsage> {
    const server = createSdkMcpServer({
      name: SERVER,
      version: '0.1.0',
      tools: tools.map((def) =>
        tool(def.name, def.description, def.shape, async (args) => ({
          content: [{ type: 'text' as const, text: await invokeTool(def, args, ctx) }],
        })),
      ),
    });

    const abortController = new AbortController();
    signal?.addEventListener('abort', () => abortController.abort());

    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: task.prompt }, parent_tool_use_id: null } as SDKUserMessage;
    }

    const usage: RunUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const q = query({
      prompt: prompt(),
      options: {
        cwd: ctx.project.root,
        systemPrompt: task.system,
        model: this.opts.model ?? ctx.project.config.model,
        maxTurns: this.opts.maxTurns ?? 120,
        mcpServers: { [SERVER]: server },
        // no built-in tools: every file access goes through code2spec tools, which block secrets (.env, keys)
        tools: [],
        allowedTools: tools.map((t) => `mcp__${SERVER}__${t.name}`),
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        abortController,
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'assistant') {
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === 'tool_use') ctx.project.log('debug', `→ ${String(block.name).replace(`mcp__${SERVER}__`, '')} ${JSON.stringify(block.input).slice(0, 160)}`, ctx.stage, ctx.taskId);
          else if (block.type === 'text' && block.text.trim()) ctx.project.log('debug', block.text.trim().slice(0, 400), ctx.stage, ctx.taskId);
        }
      } else if (msg.type === 'result') {
        const r = msg as any;
        usage.costUsd = r.total_cost_usd ?? 0;
        usage.inputTokens = (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0);
        usage.outputTokens = r.usage?.output_tokens ?? 0;
        if (r.subtype !== 'success' || r.is_error) {
          throw new Error(`Agent stopped: ${r.subtype}${r.result ? ` — ${String(r.result).slice(0, 300)}` : ''}${r.errors ? ` ${JSON.stringify(r.errors).slice(0, 300)}` : ''}`);
        }
        break;
      }
    }
    return usage;
  }
}
