import type { AgentRunner, RunUsage } from '../src/ai/runner.js';
import type { TaskPrompt } from '../src/ai/prompts.js';
import { invokeTool, type TaskContext, type ToolDef } from '../src/ai/tools.js';

export type Script = (call: (tool: string, args: unknown) => Promise<any>, ctx: TaskContext, task: TaskPrompt) => Promise<void>;

/** Deterministic stand-in for the LLM: runs a scripted sequence of tool calls per stage. */
export class MockRunner implements AgentRunner {
  readonly name = 'mock';
  calls: { stage: string; tool: string; result: any }[] = [];

  constructor(private scripts: Record<string, Script>) {}

  async run(task: TaskPrompt, tools: ToolDef[], ctx: TaskContext): Promise<RunUsage> {
    const script = this.scripts[ctx.stage];
    if (!script) throw new Error(`No mock script for ${ctx.stage}`);
    const call = async (name: string, args: unknown) => {
      const def = tools.find((t) => t.name === name);
      if (!def) throw new Error(`Tool ${name} not offered to ${ctx.stage}`);
      const raw = await invokeTool(def, args, ctx);
      let result: any = raw;
      try { result = JSON.parse(raw); } catch { /* text result */ }
      this.calls.push({ stage: ctx.stage, tool: name, result });
      return result;
    };
    await script(call, ctx, task);
    return { costUsd: 0.01, inputTokens: 100, outputTokens: 50 };
  }
}
