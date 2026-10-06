import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { MAIL_TYPE, type MailDetails, TeamManager, createChildSessionManager } from "../extensions/team-manager.ts";

const RUN_STATE = "pi-multiagents-v2-run-state";
const ACK = "pi-multiagents-v2-report-ack";
const CHILD = "pi-multiagents-v2-child";
const cwd = "/tmp/outbox-project";

function assistant(text: string) {
  return {
    role: "assistant" as const, content: [{ type: "text" as const, text }],
    api: "test", provider: "test", model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const, timestamp: Date.now(),
  };
}

type Mail = { customType: string; content: string; display: boolean; details: MailDetails };
type TestInternals = {
  nodes: Map<string, {
    session?: AgentSession;
    sessionManager?: SessionManager;
  }>;
  runNode(node: unknown, task: string): Promise<void>;
};
function internals(team: TeamManager): TestInternals {
  return team as unknown as TestInternals;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-completion-outbox-"));
  const parent = SessionManager.create(cwd, dir);
  parent.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
  const child = createChildSessionManager(cwd, parent, "/root/worker");
  child.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
  parent.appendCustomEntry(CHILD, {
    version: 1, path: "/root/worker", parent: "/root",
    sessionId: child.getSessionId(), activeTools: [],
  });
  const teams: TeamManager[] = [];
  const start = (
    manager: SessionManager,
    deliver: (message: Mail, options: unknown) => void,
    busy = () => false,
  ) => {
    const team = new TeamManager({ sendMessage: deliver } as unknown as ExtensionAPI);
    team.start({
      cwd, sessionManager: manager, isProjectTrusted: () => true,
      isIdle: () => !busy(), hasPendingMessages: () => busy(),
    } as unknown as ExtensionContext);
    teams.push(team);
    return team;
  };
  const run = async (team: TeamManager, error?: string, path = "/root/worker") => {
    const node = internals(team).nodes.get(path)!;
    const manager = node.sessionManager!;
    node.session = {
      sessionManager: manager,
      messages: [assistant("answer")],
      async prompt() {
        if (error) throw new Error(error);
        manager.appendMessage(assistant("answer"));
      },
      async abort() {},
      dispose() {},
    } as unknown as AgentSession;
    await internals(team).runNode(node, "work");
  };
  const pending = (team: TeamManager, path = "/root/worker") => team.list("/root").agents
    .find((node) => node.agent_name === path)!.pending_notifications;
  const messages = (manager: SessionManager) => manager.getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === MAIL_TYPE);
  return {
    parent, child, dir, start, run, pending, messages,
    openParent: () => SessionManager.open(parent.getSessionFile()!, dir, cwd),
    async cleanup() {
      await Promise.all(teams.map((team) => team.dispose()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("completion persists execution and report together, then acknowledges ordinary delivery", async () => {
  const f = await fixture();
  try {
    let sent: Mail | undefined;
    let options: unknown;
    const team = f.start(f.parent, (message, deliveryOptions) => {
      sent = message;
      options = deliveryOptions;
      const source = internals(team).nodes.get("/root/worker")!.sessionManager!;
      const terminal = source.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === RUN_STATE);
      assert.equal(terminal?.type, "custom");
      if (terminal?.type === "custom") {
        const data = terminal.data as { state: string; report: { id: string; payload: string } };
        assert.equal(data.state, "completed");
        assert.equal(data.report.id, message.details.reportId);
        assert.equal(data.report.payload, "answer");
      }
      f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await f.run(team);
    assert.equal(f.pending(team), 1);
    await team.retryCompletionReports();
    assert.equal(f.pending(team), 0);
    assert.equal(f.messages(f.parent).length, 1);
    assert.match(sent!.details.reportId!, /^[\da-f-]{36}$/);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  } finally { await f.cleanup(); }
});

test("failed completion delivery remains pending and retries with the same report ID", async () => {
  const f = await fixture();
  try {
    const attempts: Mail[] = [];
    const team = f.start(f.parent, (message) => {
      attempts.push(message);
      if (attempts.length === 1) throw new Error("send failed");
      f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await f.run(team);
    assert.equal(f.pending(team), 1);
    await team.retryCompletionReports();
    await team.retryCompletionReports();
    assert.equal(f.pending(team), 0);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].details.reportId, attempts[1].details.reportId);
    assert.equal(f.messages(f.parent).length, 1);
  } finally { await f.cleanup(); }
});

test("reload retries an unappended queued report without rerunning the finished child", async () => {
  const f = await fixture();
  try {
    let queued: Mail | undefined;
    const first = f.start(f.parent, (message) => { queued = message; }, () => true);
    await f.run(first);
    await first.retryCompletionReports();
    assert.equal(f.pending(first), 1);
    await first.dispose();

    const reopened = f.openParent();
    const attempts: Mail[] = [];
    const second = f.start(reopened, (message) => {
      attempts.push(message);
      reopened.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await second.retryCompletionReports();
    await second.retryCompletionReports();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].details.reportId, queued!.details.reportId);
    assert.equal(f.pending(second), 0);
    assert.deepEqual(second.list("/root").agents[1].agent_status, { completed: "answer" });
  } finally { await f.cleanup(); }
});

test("reload after recipient append but before sender acknowledgment does not duplicate delivery", async () => {
  const f = await fixture();
  try {
    const first = f.start(f.parent, (message) => {
      f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await f.run(first);
    assert.equal(f.pending(first), 1);
    await first.dispose();
    const reopened = f.openParent();
    let attempts = 0;
    const second = f.start(reopened, () => { attempts++; });
    await second.retryCompletionReports();
    assert.equal(attempts, 0);
    assert.equal(f.messages(reopened).length, 1);
    assert.equal(f.pending(second), 0);
    const persistedChild = internals(second).nodes.get("/root/worker")!.sessionManager!;
    assert.match(await readFile(persistedChild.getSessionFile()!, "utf8"), new RegExp(ACK));
  } finally { await f.cleanup(); }
});

test("errored child completion is durable and retried after reload", async () => {
  const f = await fixture();
  try {
    const first = f.start(f.parent, () => { throw new Error("offline"); });
    await f.run(first, "model failed");
    assert.equal(f.pending(first), 1);
    assert.deepEqual(first.list("/root").agents[1].agent_status, { errored: "model failed" });
    await first.dispose();
    const reopened = f.openParent();
    const sent: Mail[] = [];
    const second = f.start(reopened, (message) => {
      sent.push(message);
      reopened.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await second.retryCompletionReports();
    await second.retryCompletionReports();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.payload, "Agent error: model failed");
    assert.equal(f.pending(second), 0);
  } finally { await f.cleanup(); }
});

test("swallowed async root send failure retries only once the root is idle", async () => {
  const f = await fixture();
  try {
    let busy = true;
    let attempts = 0;
    const team = f.start(f.parent, (message) => {
      attempts++;
      if (attempts > 1) {
        f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      }
    }, () => busy);
    await f.run(team);
    await team.retryCompletionReports();
    assert.equal(attempts, 1);
    busy = false;
    await team.retryCompletionReports();
    await team.retryCompletionReports();
    assert.equal(attempts, 2);
    assert.equal(f.pending(team), 0);
  } finally { await f.cleanup(); }
});

test("acknowledgment write failure retries without sending another answer", async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    const team = f.start(f.parent, (message) => {
      attempts++;
      f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    await f.run(team);
    const source = internals(team).nodes.get("/root/worker")!.sessionManager!;
    const append = source.appendCustomEntry.bind(source);
    let fail = true;
    source.appendCustomEntry = (type, data) => {
      if (type === ACK && fail) throw new Error("ack unavailable");
      return append(type, data);
    };
    await team.retryCompletionReports();
    assert.equal(f.pending(team), 1);
    fail = false;
    await team.retryCompletionReports();
    assert.equal(f.pending(team), 0);
    assert.equal(attempts, 1);
  } finally { await f.cleanup(); }
});

test("terminal intent write failure never sends until persistence succeeds", async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    const team = f.start(f.parent, (message) => {
      attempts++;
      f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    });
    const source = internals(team).nodes.get("/root/worker")!.sessionManager!;
    const append = source.appendCustomEntry.bind(source);
    let fail = true;
    source.appendCustomEntry = (type, data) => {
      const state = data as { state?: string };
      if (type === RUN_STATE && state.state === "completed" && fail) throw new Error("disk unavailable");
      return append(type, data);
    };
    await f.run(team);
    assert.deepEqual(team.list("/root").agents[1].agent_status, { completed: "answer" });
    assert.equal(attempts, 0);
    assert.equal(f.pending(team), 1);
    fail = false;
    await team.retryCompletionReports();
    await team.retryCompletionReports();
    assert.equal(attempts, 1);
    assert.equal(f.pending(team), 0);
  } finally { await f.cleanup(); }
});

test("nested completion preserves nextTurn delivery, retaining the outbox until actual append", async () => {
  const f = await fixture();
  try {
    const descendant = createChildSessionManager(cwd, f.child, "/root/worker/scout");
    descendant.appendMessage({ role: "user", content: "explore", timestamp: Date.now() });
    f.child.appendCustomEntry(CHILD, {
      version: 1, path: "/root/worker/scout", parent: "/root/worker",
      sessionId: descendant.getSessionId(), activeTools: [],
    });
    const team = f.start(f.parent, () => { throw new Error("wrong recipient"); });
    const worker = internals(team).nodes.get("/root/worker")!;
    const manager = worker.sessionManager!;
    const queued: Mail[] = [];
    let options: unknown;
    worker.session = {
      async sendCustomMessage(message: Mail, deliveryOptions: unknown) {
        queued.push(message);
        options = deliveryOptions;
      },
      async abort() {}, dispose() {},
    } as unknown as AgentSession;
    await f.run(team, undefined, "/root/worker/scout");
    await team.retryCompletionReports();
    assert.equal(queued.length, 1);
    assert.equal(f.pending(team, "/root/worker/scout"), 1);
    assert.deepEqual(options, { triggerTurn: false, deliverAs: "nextTurn" });
    const message = queued[0];
    manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    await team.retryCompletionReports();
    assert.equal(f.pending(team, "/root/worker/scout"), 0);
    assert.equal(queued.length, 1);
  } finally { await f.cleanup(); }
});

test("extension-only reload does not duplicate an existing busy root steering queue", async () => {
  const f = await fixture();
  try {
    let queued: Mail | undefined;
    const first = f.start(f.parent, (message) => { queued = message; }, () => true);
    await f.run(first);
    await first.dispose();
    let replays = 0;
    // Unlike a process restart, /reload keeps this same root session and queue.
    const second = f.start(f.parent, () => { replays++; }, () => true);
    await second.retryCompletionReports();
    assert.equal(replays, 0);
    assert.equal(f.pending(second), 1);
    const message = queued!;
    f.parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    await second.retryCompletionReports();
    assert.equal(replays, 0);
    assert.equal(f.pending(second), 0);
    assert.equal(f.messages(f.parent).length, 1);
  } finally { await f.cleanup(); }
});

test("a pre-admission error flushes the otherwise setup-only child session and its error outbox", async () => {
  const f = await fixture();
  try {
    const team = f.start(f.parent, () => { throw new Error("offline"); });
    const node = internals(team).nodes.get("/root/worker")!;
    // Fresh fork_turns=none child: Pi has not persisted any setup-only entries yet.
    const fresh = createChildSessionManager(cwd, f.parent, "/root/worker");
    node.sessionManager = fresh;
    await f.run(team, "failed before prompt admission");
    const reopened = SessionManager.open(fresh.getSessionFile()!, f.dir, cwd);
    const terminal = reopened.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === RUN_STATE);
    assert.equal(terminal?.type, "custom");
    if (terminal?.type === "custom") {
      const data = terminal.data as { state: string; report: { payload: string } };
      assert.equal(data.state, "errored");
      assert.equal(data.report.payload, "Agent error: failed before prompt admission");
    }
    assert.equal(f.pending(team), 1);
  } finally { await f.cleanup(); }
});
