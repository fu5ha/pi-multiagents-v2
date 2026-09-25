/** Pi tool definitions that expose collaboration operations to each agent. */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentStatus } from "./core.ts";
import type { TeamManager } from "./team-manager.ts";

interface ListedAgent {
  agent_name: string;
  agent_status: AgentStatus;
}

interface WaitDetails {
  message: string;
  timed_out: boolean;
  waiting_agent: string;
  waited_on: string[];
  timeout_ms: number;
}

const COLLAPSED_AGENT_LIMIT = 3;

/** Converts a lifecycle status to transcript-friendly text. */
function describeAgentStatus(status: AgentStatus): { icon: string; label: string; detail?: string } {
  if (status === "running") return { icon: "⏳", label: "running" };
  if (status === "pending_init") return { icon: "…", label: "pending" };
  if (status === "interrupted") return { icon: "■", label: "interrupted" };
  if (status === "shutdown") return { icon: "■", label: "shutdown" };
  if (status === "not_found") return { icon: "?", label: "not found" };
  if ("errored" in status) return { icon: "✗", label: "failed", detail: status.errored };
  return { icon: "✓", label: "completed", detail: status.completed ?? undefined };
}

/** Formats milliseconds compactly without losing sub-second timeouts. */
function formatDuration(milliseconds: number): string {
  return milliseconds >= 1_000 && milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

/** Creates a compact one-line preview for tool-call arguments. */
function preview(value: string, limit = 72): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

/** Extracts Pi's model-facing error text for the visible failure body. */
function resultError(result: { content: readonly { type: string; text?: string }[] }, fallback: string): string {
  return result.content.find((part) => part.type === "text" && part.text)?.text ?? fallback;
}

/** Wraps a structured collaboration result for Pi and the model. */
function toolResult<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/** Uses TeamManager's stable per-agent color when available, with a test/mock fallback. */
function formatAgentName(team: TeamManager, path: string, restoreAnsi?: string): string {
  const formatter = (team as TeamManager & { formatAgentName?: (path: string, restoreAnsi?: string) => string }).formatAgentName;
  return formatter ? formatter.call(team, path, restoreAnsi) : `\`${path}\``;
}

/** Returns a theme background ANSI sequence when available. */
function bgAnsi(theme: { getBgAnsi?: (color: "toolSuccessBg") => string }, color: "toolSuccessBg"): string | undefined {
  return theme.getBgAnsi?.(color);
}

/** Creates collaboration tools bound to one sending agent. */
export function createCollaborationTools(team: TeamManager, source: string): ToolDefinition[] {
  /** Spawns a child agent with an independent context. */
  const spawnAgent = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn an agent for a concrete, bounded subtask. The child gets a canonical path, independent context, shared filesystem, the same active tools, and recursive delegation tools.",
    promptSnippet: "Spawn a child agent for independent parallel work",
    parameters: Type.Object(
      {
        task_name: Type.String({ description: "Lowercase letters, digits, and underscores" }),
        message: Type.String({ description: "Initial task for the child" }),
        fork_turns: Type.Optional(Type.String({ description: '"none", "all" (default), or a positive integer string' })),
        agent_type: Type.Optional(Type.String({ description: "Optional role instruction" })),
        model: Type.Optional(Type.String({ description: "Optional provider/model override for non-full forks" })),
        reasoning_effort: Type.Optional(
          StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult(await team.spawn(source, params, ctx));
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("accent", args.task_name);
      if (args.agent_type) text += theme.fg("dim", ` (${args.agent_type})`);
      const task = context.expanded ? args.message : preview(args.message);
      if (task) text += `\n${theme.fg("toolOutput", task)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const error = result.content.find((part) => part.type === "text")?.text ?? "Unknown error";
        return new Text(`\n${theme.fg("error", "Failed to start agent")}\n${theme.fg("muted", error)}`, 0, 0);
      }
      const path = (result.details as { task_name?: string } | undefined)?.task_name ?? context.args.task_name;
      return new Text(
        `\n${theme.fg("success", "Started ")}${formatAgentName(team, path, bgAnsi(theme, "toolSuccessBg"))}`,
        0,
        0,
      );
    },
  });

  /** Queues information without waking an idle recipient. */
  const sendMessage = defineTool({
    name: "send_message",
    label: "Send Message",
    description: "Queue a message for an existing agent. It does not start a new turn for an idle agent.",
    promptSnippet: "Send information to a running agent without waking an idle one",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }), message: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.sendMessage(source, params.target, params.message));
    },
    renderCall(args, theme, context) {
      const message = context.expanded ? args.message : preview(args.message);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("send_message "))}${theme.fg("accent", args.target)}\n${theme.fg("toolOutput", message)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return new Text(`\n${theme.fg("error", resultError(result, "Message failed"))}`, 0, 0);
      const target = (result.details as { target?: string } | undefined)?.target ?? context.args.target;
      return new Text(`\n${theme.fg("success", "Sent to ")}${formatAgentName(team, target, bgAnsi(theme, "toolSuccessBg"))}`, 0, 0);
    },
  });

  /** Assigns new work and starts or steers the recipient. */
  const followupTask = defineTool({
    name: "followup_task",
    label: "Follow-up Task",
    description: "Give an existing non-root agent another task, starting it if idle or steering it if running.",
    promptSnippet: "Give an existing agent more work and trigger its turn",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }), message: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.followup(source, params.target, params.message));
    },
    renderCall(args, theme, context) {
      const message = context.expanded ? args.message : preview(args.message);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("followup_task "))}${theme.fg("accent", args.target)}\n${theme.fg("toolOutput", message)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return new Text(`\n${theme.fg("error", resultError(result, "Follow-up failed"))}`, 0, 0);
      const target = (result.details as { target?: string } | undefined)?.target ?? context.args.target;
      return new Text(
        `\n${theme.fg("success", "Queued for ")}${formatAgentName(team, target, bgAnsi(theme, "toolSuccessBg"))}`,
        0,
        0,
      );
    },
  });

  /** Waits for mailbox or steering activity. */
  const waitAgent = defineTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait for mailbox activity, steered user input, or timeout. Actual mailbox content arrives separately in context.",
    promptSnippet: "Wait for agent mail only when blocked on it",
    parameters: Type.Object(
      { timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      const summary = team.waitSummary(source, params.timeout_ms);
      return toolResult({ ...(await team.wait(source, params.timeout_ms, signal)), ...summary });
    },
    renderCall(args, theme) {
      const summary = team.waitSummary(source, args.timeout_ms);
      const target = summary.waited_on.length > 0 ? summary.waited_on.join(", ") : `mail to ${summary.waiting_agent}`;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wait_agent "))}${theme.fg("accent", target)}${theme.fg("dim", ` (${formatDuration(summary.timeout_ms)})`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) return new Text(`\n${theme.fg("error", resultError(result, "Wait failed"))}`, 0, 0);
      const details = result.details as WaitDetails | undefined;
      if (!details) return new Text(`\n${theme.fg("success", `Wait completed for ${source}`)}`, 0, 0);

      const summary = details.timed_out
        ? theme.fg("warning", `Timed out after ${formatDuration(details.timeout_ms)}`)
        : theme.fg("success", `Completed for ${details.waiting_agent}`);
      if (!expanded) return new Text(`\n${summary}`, 0, 0);

      const waitedOn = details.waited_on.length > 0 ? details.waited_on.join(", ") : "(mailbox activity)";
      return new Text(
        `\n${summary}\n${theme.fg("dim", `Waiting agent: ${details.waiting_agent}`)}\n${theme.fg("dim", `Waited on: ${waitedOn}`)}\n${theme.fg("toolOutput", details.message)}`,
        0,
        0,
      );
    },
  });

  /** Lists known agents and their latest states. */
  const listAgents = defineTool({
    name: "list_agents",
    label: "List Agents",
    description: "List agents and their latest status, optionally below a task-path prefix.",
    promptSnippet: "Inspect the current hierarchical agent tree",
    parameters: Type.Object(
      { path_prefix: Type.Optional(Type.String({ description: "Relative or canonical task path" })) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(team.list(source, params.path_prefix));
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("list_agents"));
      if (args.path_prefix) text += ` ${theme.fg("accent", args.path_prefix)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) return new Text(`\n${theme.fg("error", resultError(result, "Failed to list agents"))}`, 0, 0);
      const agents = (result.details as { agents?: ListedAgent[] } | undefined)?.agents ?? [];
      const running = agents.filter(
        (agent) => agent.agent_status === "running" || agent.agent_status === "pending_init",
      ).length;
      const done = agents.filter(
        (agent) => typeof agent.agent_status === "object" && "completed" in agent.agent_status,
      ).length;
      const failed = agents.filter(
        (agent) => typeof agent.agent_status === "object" && "errored" in agent.agent_status,
      ).length;
      const lines = [
        "",
        `${theme.fg("success", `${done} done`)}${theme.fg("dim", ", ")}${theme.fg("warning", `${running} running`)}${theme.fg("dim", ", ")}${failed > 0 ? theme.fg("error", `${failed} failed`) : theme.fg("dim", "0 failed")}`,
      ];
      const visible = expanded ? agents : agents.slice(0, COLLAPSED_AGENT_LIMIT);
      for (const agent of visible) {
        const status = describeAgentStatus(agent.agent_status);
        const color = status.label === "completed" ? "success" : status.label === "failed" ? "error" : "warning";
        lines.push(
          `${theme.fg(color, status.icon)} ${theme.fg("toolOutput", agent.agent_name)}${expanded ? theme.fg("dim", ` — ${status.label}`) : ""}`,
        );
        if (expanded && status.detail) {
          lines.push(theme.fg(status.label === "failed" ? "error" : "dim", `  ${status.detail}`));
        }
      }
      if (!expanded && agents.length > visible.length) {
        lines.push(theme.fg("muted", `(+${agents.length - visible.length} more)`));
      }
      if (expanded && agents.length === 0) lines.push(theme.fg("muted", "(no matching agents)"));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  /** Interrupts a spawned agent while retaining its session. */
  const interruptAgent = defineTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Interrupt a spawned agent's current turn while preserving its context for future follow-up tasks.",
    promptSnippet: "Stop a child agent's current turn without deleting it",
    parameters: Type.Object(
      { target: Type.String({ description: "Relative child name or canonical task path" }) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await team.interrupt(source, params.target));
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("interrupt_agent "))}${theme.fg("accent", args.target)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return new Text(`\n${theme.fg("error", resultError(result, "Interrupt failed"))}`, 0, 0);
      const target = (result.details as { target?: string } | undefined)?.target ?? context.args.target;
      return new Text(
        `\n${theme.fg("warning", "Interrupted ")}${formatAgentName(team, target, bgAnsi(theme, "toolSuccessBg"))}`,
        0,
        0,
      );
    },
  });

  return [spawnAgent, sendMessage, followupTask, waitAgent, listAgents, interruptAgent];
}
