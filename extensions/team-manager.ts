/** Agent session lifecycle, scheduling, persistence, and mailbox coordination. */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentStatus,
  childPath,
  formatEnvelope,
  parseForkTurns,
  resolveTarget,
  selectForkMessages,
} from "./core.ts";
import { createCollaborationTools } from "./collaboration-tools.ts";

/** Canonical path of the primary agent. */
export const ROOT = "/root";
/** Tool names inherited by every spawned agent. */
const COLLABORATION_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
] as const;
/** Canonical extension entrypoint excluded from child resource loading. */
const SELF_PATH = safeRealpath(fileURLToPath(new URL("./index.ts", import.meta.url)));
/** Maximum number of child turns allowed to run concurrently. */
const MAX_CHILD_RUNS = positiveInteger(process.env.PI_MULTIAGENTS_MAX_CONCURRENCY, 8);
/** Pi custom-message type used for agent mail. */
export const MAIL_TYPE = "pi-multiagents-v2-message";
/** Pi custom-entry type linking a parent session to a restorable child session. */
const CHILD_ENTRY_TYPE = "pi-multiagents-v2-child";

/** Structured rendering metadata attached to inter-agent mail. */
export interface MailDetails {
  source: string;
  target: string;
  type: "MESSAGE" | "FINAL_ANSWER";
  payload: string;
}
/** Stable key for the persistent multi-agent UI surface. */
const UI_KEY = "pi-multiagents-v2";
/** Maximum widget lines; Pi may truncate longer widgets. */
const MAX_WIDGET_LINES = 8;
/** 256-color ANSI background colors assigned to agents when they are created. */
const AGENT_COLORS = [27, 34, 93, 201, 51, 208, 129, 46, 15, 33, 165, 220] as const;
type AgentColor = (typeof AGENT_COLORS)[number];

/** Creates a named child session with the parent's persistence policy. */
export function createChildSessionManager(
  cwd: string,
  sourceSessionManager: Pick<SessionManager, "getSessionFile" | "getSessionDir">,
  path: string,
): SessionManager {
  const parentSession = sourceSessionManager.getSessionFile();
  const sessionManager = parentSession
    ? SessionManager.create(cwd, sourceSessionManager.getSessionDir(), { parentSession })
    : SessionManager.inMemory(cwd);
  sessionManager.appendSessionInfo(path);
  return sessionManager;
}

/** Parameters accepted by the spawn operation. */
interface SpawnParams {
  task_name: string;
  message: string;
  fork_turns?: string;
  agent_type?: string;
  model?: string;
  reasoning_effort?: ThinkingLevel;
}

/** Runtime state retained for one agent in the hierarchy. */
interface AgentNode {
  path: string;
  parent: string | null;
  session?: AgentSession;
  loadingSession?: Promise<AgentSession>;
  sessionManager?: SessionManager;
  registration?: ChildRegistration;
  status: AgentStatus;
  color: AgentColor;
  pendingTasks: string[];
  queued: boolean;
  running: boolean;
  interrupted: boolean;
  activityVersion: number;
  consumedActivityVersion: number;
  lastActivity: "mailbox" | "steered";
  waiters: Set<(activity: "mailbox" | "steered") => void>;
}

/** Parses a positive integer or returns a fallback. */
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolves a real path while tolerating absent files. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Returns the latest non-empty assistant text. */
function lastAssistantText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

interface ParentContextReference {
  sessionId: string;
  messageId: string | null;
}

interface ChildRegistration {
  version: 1;
  path: string;
  parent: string;
  sessionId: string;
  agentType?: string;
  activeTools: string[];
  parentContext?: ParentContextReference;
}

/** Returns the parent session entry immediately before the assistant turn containing a spawn call. */
function parentContextReference(
  sessionManager: Pick<SessionManager, "getSessionId" | "getBranch" | "getLeafId">,
  toolCallId: string,
): ParentContextReference {
  const branch = sessionManager.getBranch();
  const spawnIndex = branch.findLastIndex((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      return false;
    }
    return entry.message.content.some(
      (part) => part.type === "toolCall" && part.id === toolCallId && part.name === "spawn_agent",
    );
  });
  return {
    sessionId: sessionManager.getSessionId(),
    messageId: spawnIndex >= 0 ? branch[spawnIndex].parentId : sessionManager.getLeafId(),
  };
}

/** Builds identity and collaboration guidance for a child agent. */
function subagentInstructions(
  path: string,
  parent: string,
  role?: string,
  parentContext?: ParentContextReference,
): string {
  const contextGuidance = parentContext
    ? `
Parent context reference (for omitted history):
- session_id: ${parentContext.sessionId}
- message_id: ${parentContext.messageId ?? "null"}

To recover omitted parent context, recursively find the JSONL file ending in \`_${parentContext.sessionId}.jsonl\` under \`~/.pi/agent/sessions/\` (or the configured \`sessionDir\` / \`PI_CODING_AGENT_SESSION_DIR\`), locate the entry whose \`id\` equals \`${parentContext.messageId ?? "null"}\`, and follow its \`parentId\` chain only as far back as needed. Pi session format: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
If no matching JSONL exists, the parent was likely an in-memory sub-agent session, or was otherwise explicitly configured as an in-memory session, so its omitted context cannot be recovered from disk.
`
    : "";
  return `
You are ${path}, an agent in a team collaborating on the user's task. Your direct parent is ${parent}.${role ? ` Your requested agent type is ${role}.` : ""}
You have an independent context window but share the same working directory and filesystem with every agent. You may spawn children with spawn_agent. Use disjoint write scopes and tell your parent which files you changed.
Use send_message for information that should not wake an idle agent and followup_task for new work that should start a turn. Your final response is automatically delivered to ${parent}; do not repeatedly poll or resend it.
Incoming team messages use NEW_TASK, MESSAGE, or FINAL_ANSWER envelopes. Canonical task names begin at /root.${contextGuidance}`;
}

/** Owns agent sessions, scheduling, messaging, and lifecycle state. */
export class TeamManager {
  private readonly nodes = new Map<string, AgentNode>();
  private readonly reservedPaths = new Set<string>();
  private readonly runQueue: AgentNode[] = [];
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private cwd = process.cwd();
  private activeChildRuns = 0;
  private disposed = false;
  private projectTrusted = false;
  private ui?: ExtensionContext["ui"];
  private panelPinned = false;
  private panelPopupActive = false;
  private panelPopupTimer?: NodeJS.Timeout;
  private uiMode?: ExtensionContext["mode"];
  private tuiWidgetRegistered = false;
  private nextColorIndex = 0;
  private readonly pi: ExtensionAPI;

  /** Creates a team rooted at `/root`. */
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.nodes.set(ROOT, this.newNode(ROOT, null));
  }

  /** Initializes root state for the active Pi session. */
  start(ctx: ExtensionContext): void {
    this.cwd = ctx.cwd;
    this.projectTrusted = ctx.isProjectTrusted();
    this.ui = ctx.hasUI ? ctx.ui : undefined;
    this.uiMode = ctx.hasUI ? ctx.mode : undefined;
    this.tuiWidgetRegistered = false;
    if (this.ui && this.uiMode === "tui") {
      this.ui.setWidget(UI_KEY, () => this.createTuiWidget());
      this.tuiWidgetRegistered = true;
    }
    const root = this.requireNode(ROOT);
    root.status = { completed: null };
    if (ctx.sessionManager) this.restoreChildren(ROOT, ctx.sessionManager);
    this.refreshUi();
  }

  /** Updates the root agent's externally visible status. */
  setRootStatus(status: AgentStatus): void {
    const root = this.nodes.get(ROOT);
    if (root) root.status = status;
    this.refreshUi();
  }

  /** Toggles whether the multi-agent panel stays visible between status-change popups. */
  togglePanel(): boolean {
    this.panelPinned = !this.panelPinned;
    this.refreshUi();
    return this.panelPinned;
  }

  /** Formats an agent path/name with its assigned color for text-based UI. */
  formatAgentName(path: string, restoreAnsi = "\x1b[0m"): string {
    const node = this.nodes.get(path);
    const names = path.split("/").filter(Boolean);
    const name = names[names.length - 1] ?? path;
    return node ? this.ansiBg(node.color, ` ${name} `, restoreAnsi) : name;
  }

  /** Wakes root waiters when user input steers the current turn. */
  signalRootSteer(): void {
    this.signalActivity(ROOT, "steered");
  }

  /** Creates initial runtime state for an agent path. */
  private newNode(path: string, parent: string | null): AgentNode {
    return {
      path,
      parent,
      status: "pending_init",
      color: AGENT_COLORS[this.nextColorIndex++ % AGENT_COLORS.length],
      pendingTasks: [],
      queued: false,
      running: false,
      interrupted: false,
      activityVersion: 0,
      consumedActivityVersion: 0,
      lastActivity: "mailbox",
      waiters: new Set(),
    };
  }

  /** Returns a known node or throws for an invalid path. */
  private requireNode(path: string): AgentNode {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent not found: ${path}`);
    return node;
  }

  /** Resolves an agent reference and returns its node. */
  private resolve(current: string, target: string): AgentNode {
    return this.requireNode(resolveTarget(current, target));
  }

  /** Lazily creates the model runtime shared by child sessions. */
  private modelRuntime(): Promise<ModelRuntime> {
    return (this.modelRuntimePromise ??= ModelRuntime.create());
  }

  /** Restores persisted child registrations from the active branch of a parent session. */
  private restoreChildren(
    parent: string,
    parentSessionManager: Pick<SessionManager, "getBranch" | "getSessionDir">,
  ): void {
    for (const entry of parentSessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CHILD_ENTRY_TYPE) continue;
      const registration = this.parseChildRegistration(entry.data);
      if (!registration || registration.parent !== parent || this.nodes.has(registration.path)) continue;
      const sessionFile = SessionManager.findById(this.cwd, registration.sessionId, parentSessionManager.getSessionDir());
      if (!sessionFile) continue;

      const sessionManager = SessionManager.open(sessionFile, parentSessionManager.getSessionDir(), this.cwd);
      const node = this.newNode(registration.path, parent);
      node.sessionManager = sessionManager;
      node.registration = registration;
      node.status = { completed: lastAssistantText(sessionManager.buildSessionContext().messages) };
      this.nodes.set(node.path, node);
      this.restoreChildren(node.path, sessionManager);
    }
  }

  /** Validates a persisted child registration without trusting arbitrary custom-entry data. */
  private parseChildRegistration(value: unknown): ChildRegistration | undefined {
    if (!value || typeof value !== "object") return undefined;
    const item = value as Partial<ChildRegistration>;
    const parentContext = item.parentContext;
    const validParentContext =
      parentContext === undefined ||
      (typeof parentContext === "object" &&
        parentContext !== null &&
        typeof parentContext.sessionId === "string" &&
        (typeof parentContext.messageId === "string" || parentContext.messageId === null));
    if (
      item.version !== 1 ||
      typeof item.path !== "string" ||
      typeof item.parent !== "string" ||
      !item.path.startsWith(`${item.parent}/`) ||
      typeof item.sessionId !== "string" ||
      (item.agentType !== undefined && typeof item.agentType !== "string") ||
      !Array.isArray(item.activeTools) ||
      !item.activeTools.every((tool) => typeof tool === "string") ||
      !validParentContext
    ) {
      return undefined;
    }
    return item as ChildRegistration;
  }

  /** Reads the source agent messages available for context forking. */
  private sourceMessages(source: string, ctx: ExtensionContext): AgentMessage[] {
    if (source !== ROOT) return [...this.requireNode(source).session!.messages];
    return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  }

  /** Reads the active tools inherited from a source agent. */
  private sourceTools(source: string): string[] {
    return source === ROOT ? this.pi.getActiveTools() : this.requireNode(source).session!.getActiveToolNames();
  }

  /** Reads the model inherited from a source agent. */
  private sourceModel(source: string, ctx: ExtensionContext): Model<any> | undefined {
    return source === ROOT ? ctx.model : this.requireNode(source).session!.model;
  }

  /** Reads the reasoning level inherited from a source agent. */
  private sourceThinking(source: string, ctx: ExtensionContext): ThinkingLevel {
    return (source === ROOT ? ctx.thinkingLevel : this.requireNode(source).session!.thinkingLevel) ?? "off";
  }

  /** Creates an executable AgentSession around a new or restored child session manager. */
  private async createManagedSession(
    registration: ChildRegistration,
    sessionManager: SessionManager,
    model?: Model<any>,
    thinkingLevel?: ThinkingLevel,
  ): Promise<AgentSession> {
    const settingsManager = SettingsManager.create(this.cwd, getAgentDir());
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) => {
          const isThisExtension =
            safeRealpath(extension.resolvedPath) === SELF_PATH ||
            (extension.tools.has("spawn_agent") && extension.tools.has("followup_task"));
          const isUntrustedProjectExtension = extension.sourceInfo.scope === "project" && !this.projectTrusted;
          return !isThisExtension && !isUntrustedProjectExtension;
        }),
      }),
      appendSystemPromptOverride: (base) => [
        ...base,
        subagentInstructions(
          registration.path,
          registration.parent,
          registration.agentType,
          registration.parentContext,
        ),
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      modelRuntime: await this.modelRuntime(),
      model,
      thinkingLevel,
      tools: registration.activeTools,
      customTools: this.createTools(registration.path),
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    try {
      await session.bindExtensions({ mode: "print" });
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  /** Lazily recreates a restored child's executable session. */
  private async ensureSession(node: AgentNode): Promise<AgentSession> {
    if (this.disposed) throw new Error("Agent team is shutting down");
    if (node.session) return node.session;
    if (node.loadingSession) return node.loadingSession;
    if (!node.sessionManager || !node.registration) throw new Error(`Agent session cannot be restored: ${node.path}`);
    node.loadingSession = this.createManagedSession(node.registration, node.sessionManager);
    try {
      node.session = await node.loadingSession;
      return node.session;
    } finally {
      node.loadingSession = undefined;
    }
  }

  /** Creates and schedules a child agent session. */
  async spawn(source: string, params: SpawnParams, ctx: ExtensionContext, toolCallId: string) {
    if (this.disposed) throw new Error("Agent team is shutting down");
    const path = childPath(source, params.task_name);
    if (this.nodes.has(path) || this.reservedPaths.has(path)) {
      throw new Error(`Agent task already exists: ${path}; use followup_task to reuse it`);
    }

    const forkMode = parseForkTurns(params.fork_turns);
    if (forkMode === "all" && (params.model || params.reasoning_effort)) {
      throw new Error('Full-history forks inherit model and reasoning; use fork_turns="none" or a number for overrides');
    }
    const sourceSessionManager =
      source === ROOT ? ctx.sessionManager : this.requireNode(source).session!.sessionManager;
    const parentContext =
      forkMode === "all" ? undefined : parentContextReference(sourceSessionManager, toolCallId);

    this.reservedPaths.add(path);
    try {
      const inheritedModel = this.sourceModel(source, ctx);
      let model = inheritedModel;
      if (params.model) {
        const slash = params.model.indexOf("/");
        const provider = slash >= 0 ? params.model.slice(0, slash) : inheritedModel?.provider;
        const modelId = slash >= 0 ? params.model.slice(slash + 1) : params.model;
        model = provider ? ctx.modelRegistry.find(provider, modelId) : undefined;
        if (!model) throw new Error(`Model not found: ${params.model}`);
      }
      if (!model) throw new Error("No model is available for the child agent");

      const forkedMessages = selectForkMessages(this.sourceMessages(source, ctx), params.fork_turns);
      const sessionManager = createChildSessionManager(this.cwd, sourceSessionManager, path);
      for (const message of structuredClone(forkedMessages)) {
        sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
      }

      const registration: ChildRegistration = {
        version: 1,
        path,
        parent: source,
        sessionId: sessionManager.getSessionId(),
        agentType: params.agent_type?.trim() || undefined,
        activeTools: [...new Set([...this.sourceTools(source), ...COLLABORATION_TOOLS])],
        parentContext,
      };
      const session = await this.createManagedSession(
        registration,
        sessionManager,
        model,
        params.reasoning_effort ?? this.sourceThinking(source, ctx),
      );

      const node = this.newNode(path, source);
      node.session = session;
      node.sessionManager = sessionManager;
      node.registration = registration;
      try {
        if (sessionManager.isPersisted()) {
          if (source === ROOT) this.pi.appendEntry(CHILD_ENTRY_TYPE, registration);
          else this.requireNode(source).session!.sessionManager.appendCustomEntry(CHILD_ENTRY_TYPE, registration);
        }
      } catch (error) {
        session.dispose();
        throw error;
      }
      this.nodes.set(path, node);

      this.enqueue(node, formatEnvelope("NEW_TASK", path, source, params.message));
      return { task_name: path, status: node.status };
    } finally {
      this.reservedPaths.delete(path);
    }
  }

  /** Queues a task and schedules its agent when idle. */
  private enqueue(node: AgentNode, task: string): void {
    node.pendingTasks.push(task);
    node.interrupted = false;
    if (!node.queued && !node.running) {
      node.queued = true;
      node.status = "pending_init";
      this.runQueue.push(node);
    }
    this.refreshUi(true);
    this.pump();
  }

  /** Starts queued child turns while concurrency is available. */
  private pump(): void {
    if (this.disposed) return;
    while (this.activeChildRuns < MAX_CHILD_RUNS && this.runQueue.length > 0) {
      const node = this.runQueue.shift()!;
      node.queued = false;
      const task = node.pendingTasks.shift();
      if (!task || node.running || !node.session) continue;
      void this.runNode(node, task);
    }
  }

  /** Runs one child turn and forwards its terminal result. */
  private async runNode(node: AgentNode, task: string): Promise<void> {
    node.running = true;
    node.status = "running";
    this.activeChildRuns++;
    this.refreshUi(true);
    try {
      await node.session!.prompt(task, { expandPromptTemplates: false });
      if (node.interrupted) {
        node.status = "interrupted";
      } else {
        const output = lastAssistantText(node.session!.messages);
        node.status = { completed: output };
        if (node.parent) {
          await this.deliver(node.path, node.parent, "FINAL_ANSWER", output ?? "(no output)", false).catch(() => undefined);
        }
      }
    } catch (error) {
      if (node.interrupted) {
        node.status = "interrupted";
      } else {
        const message = error instanceof Error ? error.message : String(error);
        node.status = { errored: message };
        if (node.parent) {
          await this.deliver(node.path, node.parent, "FINAL_ANSWER", `Agent error: ${message}`, false).catch(() => undefined);
        }
      }
    } finally {
      node.running = false;
      this.activeChildRuns--;
      if (!node.interrupted && node.pendingTasks.length > 0 && !node.queued) {
        node.queued = true;
        this.runQueue.push(node);
      }
      this.refreshUi(true);
      this.pump();
    }
  }

  /** Queues a non-waking message for an existing agent. */
  async sendMessage(source: string, target: string, message: string) {
    const recipient = this.resolve(source, target);
    await this.deliver(source, recipient.path, "MESSAGE", message, false);
    return { target: recipient.path, queued: true };
  }

  /** Assigns new work and starts or steers an existing child. */
  async followup(source: string, target: string, message: string) {
    const recipient = this.resolve(source, target);
    if (recipient.path === ROOT) throw new Error("followup_task cannot target /root");
    const session = await this.ensureSession(recipient);
    const envelope = formatEnvelope("NEW_TASK", recipient.path, source, message);
    this.signalActivity(recipient.path, "mailbox");
    if (recipient.running) {
      await session.sendCustomMessage(
        { customType: MAIL_TYPE, content: envelope, display: false, details: { source, target: recipient.path } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } else {
      this.enqueue(recipient, envelope);
    }
    return { target: recipient.path, status: recipient.status };
  }

  /** Delivers a model-visible message envelope to an agent mailbox. */
  private async deliver(
    source: string,
    target: string,
    type: "MESSAGE" | "FINAL_ANSWER",
    payload: string,
    triggerTurn: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    const recipient = this.requireNode(target);
    const envelope = formatEnvelope(type, target, source, payload);
    this.signalActivity(target, "mailbox");
    const details: MailDetails = { source, target, type, payload };
    if (target === ROOT) {
      this.pi.sendMessage(
        { customType: MAIL_TYPE, content: envelope, display: true, details },
        { triggerTurn, deliverAs: "steer" },
      );
      return;
    }
    const session = await this.ensureSession(recipient);
    await session.sendCustomMessage(
      { customType: MAIL_TYPE, content: envelope, display: true, details },
      { triggerTurn, deliverAs: recipient.running ? "steer" : "nextTurn" },
    );
  }

  /** Lists known agents, optionally below a resolved path prefix. */
  list(source: string, prefix?: string) {
    const resolvedPrefix = prefix ? resolveTarget(source, prefix) : undefined;
    return {
      agents: [...this.nodes.values()]
        .filter((node) => !resolvedPrefix || node.path === resolvedPrefix || node.path.startsWith(`${resolvedPrefix}/`))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((node) => ({ agent_name: node.path, agent_status: node.status })),
    };
  }

  /** Interrupts a child turn while retaining its session. */
  async interrupt(source: string, target: string) {
    const node = this.resolve(source, target);
    if (node.path === ROOT) throw new Error("/root is not a spawned agent");
    if (node.path === source) throw new Error("An agent cannot interrupt itself");
    const previousStatus = node.status;
    node.interrupted = true;
    node.pendingTasks.length = 0;
    node.session?.clearQueue();
    if (node.running) await node.session?.abort();
    node.status = "interrupted";
    this.refreshUi(true);
    return { target: node.path, previous_status: previousStatus };
  }

  /** Describes the mailbox and active descendants a wait is observing. */
  waitSummary(source: string, timeoutMs?: number) {
    this.requireNode(source);
    const waitedOn = [...this.nodes.values()]
      .filter(
        (node) =>
          node.path.startsWith(`${source}/`) && (node.status === "running" || node.status === "pending_init"),
      )
      .map((node) => node.path)
      .sort();
    return {
      waiting_agent: source,
      waited_on: waitedOn,
      timeout_ms: Math.min(Math.max(timeoutMs ?? 30_000, 100), 3_600_000),
    };
  }

  /** Waits for mailbox activity, steering input, or timeout. */
  async wait(source: string, timeoutMs: number | undefined, signal: AbortSignal | undefined) {
    const node = this.requireNode(source);
    if (node.activityVersion > node.consumedActivityVersion) {
      node.consumedActivityVersion = node.activityVersion;
      return { message: node.lastActivity === "steered" ? "Wait interrupted by new input." : "Wait completed.", timed_out: false };
    }

    const timeout = this.waitSummary(source, timeoutMs).timeout_ms;
    const activity = await new Promise<"mailbox" | "steered" | "timeout">((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (value: "mailbox" | "steered" | "timeout") => {
        clearTimeout(timer);
        node.waiters.delete(onActivity);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onActivity = (value: "mailbox" | "steered") => finish(value);
      const onAbort = () => {
        clearTimeout(timer);
        node.waiters.delete(onActivity);
        reject(new Error("wait_agent aborted"));
      };
      node.waiters.add(onActivity);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeout);
      if (signal?.aborted) onAbort();
    });

    if (activity !== "timeout") node.consumedActivityVersion = node.activityVersion;
    return {
      message: activity === "timeout" ? "Wait timed out." : activity === "steered" ? "Wait interrupted by new input." : "Wait completed.",
      timed_out: activity === "timeout",
    };
  }

  /** Records activity and resolves every waiter on an agent. */
  private signalActivity(path: string, activity: "mailbox" | "steered"): void {
    const node = this.nodes.get(path);
    if (!node) return;
    node.activityVersion++;
    node.lastActivity = activity;
    for (const waiter of [...node.waiters]) waiter(activity);
    node.waiters.clear();
  }

  /** Converts a node status into compact UI metadata. */
  private describeStatus(status: AgentStatus): { icon: string; label: string; rank: number } {
    if (status === "running") return { icon: "⏳", label: "running", rank: 0 };
    if (status === "pending_init") return { icon: "…", label: "pending", rank: 1 };
    if (status === "interrupted") return { icon: "■", label: "interrupted", rank: 3 };
    if (status === "shutdown") return { icon: "", label: "shutdown", rank: 5 };
    if (status === "not_found") return { icon: "?", label: "not found", rank: 4 };
    if ("errored" in status) return { icon: "✗", label: "errored", rank: 2 };
    return { icon: "✓", label: "completed", rank: 4 };
  }

  /** Updates the persistent TUI/RPC-friendly widget and footer status. */
  private refreshUi(popUp = false): void {
    if (!this.ui) return;

    const children = this.visibleChildren();
    if (children.length === 0) {
      this.clearUi();
      return;
    }

    if (popUp) this.showPanelTemporarily();
    const visible = this.panelPinned || this.panelPopupActive;

    if (this.uiMode === "tui" && this.tuiWidgetRegistered) {
      // The TUI widget is registered once and renders from live TeamManager state with the exact width Pi provides.
      // setStatus(undefined) requests a render without leaving a footer/below-editor status label behind.
      this.ui.setStatus(UI_KEY, undefined);
      return;
    }

    this.ui.setWidget(UI_KEY, visible ? this.widgetLines(100) : undefined);
    this.ui.setStatus(UI_KEY, undefined);
  }

  /** Creates a TUI widget that receives the real available width from Pi at render time. */
  private createTuiWidget(): Component {
    return {
      render: (width: number) => (this.panelPinned || this.panelPopupActive ? this.widgetLines(width) : []),
      invalidate: () => undefined,
    };
  }

  /** Returns non-root nodes displayed in the panel. */
  private visibleChildren(): AgentNode[] {
    return [...this.nodes.values()].filter((node) => node.path !== ROOT && node.status !== "shutdown");
  }

  /** Builds widget lines for a known render width. */
  private widgetLines(width: number): string[] {
    const sorted = this.visibleChildren().sort((a, b) => {
      const rank = this.describeStatus(a.status).rank - this.describeStatus(b.status).rank;
      return rank || a.path.localeCompare(b.path);
    });
    const contentWidth = Math.max(20, width - 2);
    return [this.separatorLine(contentWidth), ...this.agentChipLines(sorted, contentWidth, MAX_WIDGET_LINES - 1)];
  }

  /** Makes the panel visible briefly even when the user has not pinned it on. */
  private showPanelTemporarily(): void {
    this.panelPopupActive = true;
    if (this.panelPopupTimer) clearTimeout(this.panelPopupTimer);
    this.panelPopupTimer = setTimeout(() => {
      this.panelPopupActive = false;
      this.panelPopupTimer = undefined;
      this.refreshUi();
    }, 5_000);
    this.panelPopupTimer.unref?.();
  }

  /** Builds horizontal, wrapped child-agent chips. */
  private agentChipLines(nodes: AgentNode[], maxLineLength: number, maxLines: number): string[] {
    const lines: string[] = [];
    let line = "";
    let emitted = 0;
    for (const node of nodes) {
      const chip = this.agentChip(node);
      const plainLength = this.plainTextLength(line) + (line ? 2 : 0) + this.plainTextLength(chip);
      if (line && plainLength > maxLineLength) {
        lines.push(line);
        line = "";
      }
      if (lines.length >= maxLines) break;
      line = line ? `${line}  ${chip}` : chip;
      emitted++;
    }
    if (line && lines.length < maxLines) lines.push(line);
    const hidden = nodes.length - emitted;
    if (hidden > 0 && lines.length > 0) lines[lines.length - 1] += `  +${hidden} more`;
    return lines;
  }

  /** Formats one child agent as a colored chip. */
  private agentChip(node: AgentNode): string {
    const status = this.describeStatus(node.status);
    const names = node.path.split("/").filter(Boolean);
    const name = names[names.length - 1] ?? node.path;
    return `${status.icon} ${this.ansiBg(node.color, ` ${name} `)}`;
  }

  /** Applies a standard 256-color ANSI background to a chip. */
  private ansiBg(color: AgentColor, text: string, restoreAnsi = "\x1b[0m"): string {
    const foreground = color === 15 || color === 220 ? 16 : 15;
    return `\x1b[48;5;${color}m\x1b[38;5;${foreground}m${text}\x1b[39m${restoreAnsi}`;
  }

  /** Builds a full-width separator with a compact label. */
  private separatorLine(width: number): string {
    const theme = this.ui!.theme;
    const label = " multiagents ";
    const left = "─".repeat(Math.max(2, Math.floor((width - label.length) / 2)));
    const right = "─".repeat(Math.max(2, width - label.length - left.length));
    return theme.fg("borderMuted", `${left}${label}${right}`);
  }

  /** Approximate visible length by stripping ANSI escape sequences. */
  private plainTextLength(value: string): number {
    return value.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  /** Clears the persistent multi-agent UI surface. */
  private clearUi(removeWidget = false): void {
    if (removeWidget || this.uiMode !== "tui") {
      this.ui?.setWidget(UI_KEY, undefined);
      this.tuiWidgetRegistered = false;
    }
    this.ui?.setStatus(UI_KEY, undefined);
  }

  /** Cancels any pending temporary panel hide/show timer. */
  private cancelPanelPopup(): void {
    if (this.panelPopupTimer) clearTimeout(this.panelPopupTimer);
    this.panelPopupTimer = undefined;
    this.panelPopupActive = false;
  }

  /** Creates collaboration tools bound to a child identity. */
  private createTools(source: string) {
    return createCollaborationTools(this, source);
  }

  /** Aborts and disposes every child session. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runQueue.length = 0;
    const children = [...this.nodes.values()].filter((node) => node.session || node.loadingSession);
    for (const node of children) {
      node.interrupted = true;
      node.pendingTasks.length = 0;
    }
    await Promise.all(
      children.map(async (node) => {
        const session = node.session ?? (await node.loadingSession?.catch(() => undefined));
        if (!session) return;
        await session.abort().catch(() => undefined);
        session.dispose();
      }),
    );
    for (const node of children) node.status = "shutdown";
    this.cancelPanelPopup();
    this.clearUi(true);
  }
}

