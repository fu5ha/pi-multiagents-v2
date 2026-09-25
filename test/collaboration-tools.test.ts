import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createCollaborationTools } from "../extensions/collaboration-tools.ts";
import type { TeamManager } from "../extensions/team-manager.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const context = (isError = false, args: Record<string, unknown> = {}) => ({ isError, args }) as any;
const render = (component: { render(width: number): string[] }) => component.render(80).map((line) => line.trimEnd());

test("Codex-style spawn rendering", () => {
  const spawn = createCollaborationTools({} as TeamManager, "/root").find((tool) => tool.name === "spawn_agent")!;
  const args = {
    task_name: "root_cause_242",
    message: "Find the root cause.",
  };

  assert.equal(spawn.renderShell, undefined);
  assert.deepEqual(render(spawn.renderCall!(args, theme, context(false, args))), [
    "spawn_agent root_cause_242",
    "Find the root cause.",
  ]);
  assert.deepEqual(
    render(
      spawn.renderResult!(
        {
          content: [{ type: "text", text: "ok" }],
          details: { task_name: "/root/root_cause_242", status: "running" },
        },
        { expanded: false, isPartial: false },
        theme,
        context(false, args),
      ),
    ),
    ["", "Started `/root/root_cause_242`"],
  );
  assert.deepEqual(
    render(
      spawn.renderResult!(
        { content: [{ type: "text", text: 'Full-history forks inherit model; use fork_turns="none"' }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context(true, args),
      ),
    ),
    ["", "Failed to start agent", 'Full-history forks inherit model; use fork_turns="none"'],
  );
});

test("spawn guidance follows the bundled delegation policy", () => {
  const spawn = createCollaborationTools({} as TeamManager, "/root").find((tool) => tool.name === "spawn_agent")!;
  const guidance = spawn.promptGuidelines?.join("\n") ?? "";

  assert.match(guidance, /Do not spawn sub-agents unless the user or applicable AGENTS\.md\/skill instructions explicitly ask/);
  assert.match(guidance, /critical-path blockers/);
  assert.match(guidance, /disjoint write scopes/);
  assert.match(guidance, /use wait_agent only when its result blocks/);
  assert.match(guidance, /Omitting `fork_turns` defaults to `all`/);
});

test("message, follow-up, and interrupt use standard Pi tool blocks", () => {
  const tools = createCollaborationTools({} as TeamManager, "/root");
  const cases = [
    {
      name: "send_message",
      args: { target: "/root/a", message: "hello" },
      details: { target: "/root/a", queued: true },
      call: ["send_message /root/a", "hello"],
      result: ["", "Sent to `/root/a`"],
    },
    {
      name: "followup_task",
      args: { target: "/root/a", message: "continue" },
      details: { target: "/root/a", status: "running" },
      call: ["followup_task /root/a", "continue"],
      result: ["", "Queued for `/root/a`"],
    },
    {
      name: "interrupt_agent",
      args: { target: "/root/a" },
      details: { target: "/root/a", previous_status: "running" },
      call: ["interrupt_agent /root/a"],
      result: ["", "Interrupted `/root/a`"],
    },
  ];

  for (const item of cases) {
    const tool = tools.find((candidate) => candidate.name === item.name)!;
    assert.equal(tool.renderShell, undefined);
    assert.deepEqual(render(tool.renderCall!(item.args as any, theme, context(false, item.args))), item.call);
    assert.deepEqual(
      render(
        tool.renderResult!(
          { content: [{ type: "text", text: "ok" }], details: item.details },
          { expanded: false, isPartial: false },
          theme,
          context(false, item.args),
        ),
      ),
      item.result,
    );
    assert.deepEqual(
      render(
        tool.renderResult!(
          { content: [{ type: "text", text: "Specific failure" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          context(true, item.args),
        ),
      ),
      ["", "Specific failure"],
    );
  }
});

test("compact and expanded list rendering", () => {
  const tools = createCollaborationTools({} as TeamManager, "/root");
  const list = tools.find((tool) => tool.name === "list_agents")!;
  const result = {
    content: [],
    details: {
      agents: [
        { agent_name: "/root/a", agent_status: "running" },
        { agent_name: "/root/b", agent_status: "pending_init" },
        { agent_name: "/root/c", agent_status: { completed: "Full result" } },
        { agent_name: "/root/d", agent_status: { errored: "Broken" } },
        { agent_name: "/root/e", agent_status: "interrupted" },
      ],
    },
  } as any;

  assert.equal(list.renderShell, undefined);
  assert.deepEqual(render(list.renderCall!({}, theme, context())), ["list_agents"]);
  assert.deepEqual(
    render(list.renderResult!(result, { expanded: false, isPartial: false }, theme, context())),
    ["", "1 done, 2 running, 1 failed", "⏳ /root/a", "… /root/b", "✓ /root/c", "(+2 more)"],
  );
  assert.deepEqual(
    render(list.renderResult!(result, { expanded: true, isPartial: false }, theme, context())),
    [
      "",
      "1 done, 2 running, 1 failed",
      "⏳ /root/a — running",
      "… /root/b — pending",
      "✓ /root/c — completed",
      "  Full result",
      "✗ /root/d — failed",
      "  Broken",
      "■ /root/e — interrupted",
    ],
  );
});

test("wait rendering identifies the mailbox and active agents", async () => {
  const team = {
    waitSummary: () => ({
      waiting_agent: "/root",
      waited_on: ["/root/researcher", "/root/coder"],
      timeout_ms: 30_000,
    }),
    wait: async () => ({ message: "Wait timed out.", timed_out: true }),
  } as unknown as TeamManager;
  const wait = createCollaborationTools(team, "/root").find((tool) => tool.name === "wait_agent")!;
  const details = {
    message: "Wait timed out.",
    timed_out: true,
    waiting_agent: "/root",
    waited_on: ["/root/researcher", "/root/coder"],
    timeout_ms: 30_000,
  };

  assert.equal(wait.renderShell, undefined);
  assert.deepEqual(render(wait.renderCall!({}, theme, context())), [
    "wait_agent /root/researcher, /root/coder (30s)",
  ]);
  assert.deepEqual(
    render(wait.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, context())),
    ["", "Timed out after 30s"],
  );
  assert.deepEqual(
    render(wait.renderResult!({ content: [], details }, { expanded: true, isPartial: false }, theme, context())),
    [
      "",
      "Timed out after 30s",
      "Waiting agent: /root",
      "Waited on: /root/researcher, /root/coder",
      "Wait timed out.",
    ],
  );
  assert.deepEqual(
    render(wait.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context(true))),
    ["", "Wait failed"],
  );

  const executed = await wait.execute("wait", {}, undefined as any, undefined as any, {} as any);
  assert.deepEqual(executed.details, details);
});
