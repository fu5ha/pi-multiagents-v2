/** Pi extension entrypoint that wires Multi-Agent V2 tools and lifecycle hooks. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createCollaborationTools } from "./collaboration-tools.ts";
import { createChildSessionManager, MAIL_TYPE, type MailDetails, ROOT, TeamManager } from "./team-manager.ts";

export { createChildSessionManager, TeamManager };

/** Collaboration guidance appended to the root agent prompt. */
const ROOT_INSTRUCTIONS = `
You are /root, the primary agent in a team of Pi agents.
Use spawn_agent for concrete, bounded work that can run independently while you continue useful local work. Child agents can recursively spawn their own children. All agents share the same working directory and filesystem, so give coding agents disjoint write scopes.
Use send_message to pass information without starting an idle agent, followup_task to give an existing non-root agent more work, wait_agent only when blocked on incoming work, list_agents to inspect the tree, and interrupt_agent to stop an agent's current turn. Child final answers are delivered automatically as FINAL_ANSWER messages.
Agent messages arrive in this form:
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>`;

/** Converts message content to a safe renderer fallback. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n");
}

/** Creates a compact single-line payload preview. */
function payloadPreview(payload: string, limit = 120): string {
  const singleLine = payload.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

/** Registers Multi-Agent V2 tools and lifecycle hooks. */
export default function subagentsV2(pi: ExtensionAPI) {
  const team = new TeamManager(pi);
  for (const tool of createCollaborationTools(team, ROOT)) pi.registerTool(tool);
  pi.registerMessageRenderer<MailDetails>(MAIL_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details;
    const source = details?.source ?? "unknown";
    const target = details?.target ?? "unknown";
    const type = details?.type ?? "MESSAGE";
    const payload = details?.payload ?? messageText(message.content);
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    if (!expanded) {
      const preview = payloadPreview(payload) || "(empty message)";
      const route = theme.fg("muted", `${source} → ${target}`);
      const icon = theme.fg("customMessageLabel", theme.bold("✉"));
      const label = theme.fg("customMessageLabel", theme.bold(type));
      box.addChild(new Text(`${icon} ${route} ${label}: ${theme.fg("customMessageText", preview)}`, 0, 0));
      return box;
    }
    box.addChild(
      new Text(
        `${theme.fg("customMessageLabel", theme.bold("Inter-agent message"))}\n${theme.fg("muted", `Type: ${type}`)}\n${theme.fg("muted", `From: ${source}`)}\n${theme.fg("muted", `To: ${target}`)}\n\n${theme.fg("customMessageText", payload)}`,
        0,
        0,
      ),
    );
    return box;
  });
  pi.registerCommand("multiagents", {
    description: "Toggle the persistent multi-agent status panel",
    async handler(_args, ctx) {
      const pinned = team.togglePanel();
      if (ctx.hasUI) ctx.ui.notify(`Multi-agent panel ${pinned ? "pinned" : "hidden between updates"}`, "info");
    },
  });
  pi.registerCommand("multiagents-resume", {
    description: "Resume all paused sub-agents, or one agent by path",
    async handler(args, ctx) {
      const target = args.trim() || "all";
      const result = await team.resumePaused(target);
      if (ctx.hasUI) {
        ctx.ui.notify(
          result.resumed.length > 0 ? `Resumed ${result.resumed.join(", ")}` : `No paused agents matched ${target}`,
          "info",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => team.start(ctx));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.includes("You are /root, the primary agent in a team of Pi agents.")
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${ROOT_INSTRUCTIONS}`,
  }));
  pi.on("agent_start", () => team.setRootStatus("running"));
  pi.on("agent_settled", () => team.setRootStatus({ completed: null }));
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") team.signalRootSteer();
  });
  pi.on("session_shutdown", async () => team.dispose());
}
