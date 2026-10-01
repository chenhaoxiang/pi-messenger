import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRegistration, Dirs, MessengerState } from "../lib.ts";
import {
  getActiveAgents,
  invalidateAgentsCache,
  processAllPendingMessages,
  register,
  updateRegistration,
  flushActivityToRegistry,
  sendMessageToAgent,
  stopWatcher,
} from "../store.ts";

const roots = new Set<string>();
const initialCwd = process.cwd();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-store-test-"));
  roots.add(root);
  return root;
}

function createDirs(root: string): Dirs {
  const base = path.join(root, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(scopeToFolder: boolean, cwd: string = process.cwd()): MessengerState {
  return {
    agentName: "Self",
    cwd,
    scopeToFolder,
  } as MessengerState;
}

function createRegisterState(cwd: string): MessengerState {
  return {
    agentName: "Self",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    cwd,
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };
}

function writeRegistration(registryDir: string, name: string, cwd: string): void {
  const registration: AgentRegistration = {
    name,
    pid: process.pid,
    sessionId: "session-1",
    cwd,
    model: "test-model",
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

afterEach(() => {
  vi.useRealTimers();
  invalidateAgentsCache();
  process.chdir(initialCwd);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("store.getActiveAgents cwd scoping", () => {
  it("matches scoped agents using canonical cwd", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const actualProject = path.join(root, "project");
    const aliasProject = path.join(root, "project-alias");

    fs.mkdirSync(actualProject, { recursive: true });
    fs.symlinkSync(actualProject, aliasProject, "dir");

    writeRegistration(dirs.registry, "Peer", actualProject);

    process.chdir(aliasProject);
    const agents = getActiveAgents(createState(true, aliasProject), dirs);

    expect(agents.map(agent => agent.name)).toEqual(["Peer"]);
  });

  it("uses state.cwd instead of process.cwd for scoped agent matching", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    writeRegistration(dirs.registry, "PeerA", projectA);
    writeRegistration(dirs.registry, "PeerB", projectB);

    process.chdir(projectB);
    const agents = getActiveAgents(createState(true, projectA), dirs);

    expect(agents.map(agent => agent.name)).toEqual(["PeerA"]);
  });

  it("registers the session using ctx.cwd instead of process.cwd", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    process.chdir(projectB);
    const state = createRegisterState(projectA);
    const ctx = {
      cwd: projectA,
      hasUI: false,
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => "session-1" },
    } as any;

    expect(register(state, dirs, ctx)).toBe(true);

    const expectedCwd = fs.realpathSync.native(projectA);
    const registration = JSON.parse(fs.readFileSync(path.join(dirs.registry, "Self.json"), "utf-8")) as AgentRegistration;
    expect(registration.cwd).toBe(expectedCwd);
    expect(state.cwd).toBe(expectedCwd);
  });
});

describe("store.processAllPendingMessages", () => {
  it("recovers a stale directory lock on the asynchronous retry", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), "2147483647:stale-token");
    fs.writeFileSync(path.join(lockPath, "recovery"), "2147483647:stale-recovery");
    fs.utimesSync(lockPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    fs.utimesSync(path.join(lockPath, "recovery"), new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    fs.writeFileSync(path.join(inbox, "stale-lock.json"), JSON.stringify({
      id: "stale-lock-id",
      from: "Peer",
      to: "Self",
      text: "recover me",
    }));

    const delivered: string[] = [];
    const state = { agentName: "Self", registered: true } as MessengerState;
    processAllPendingMessages(state, dirs, msg => delivered.push(msg.id));

    expect(delivered).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
    vi.advanceTimersByTime(10_000);

    expect(delivered).toEqual(["stale-lock-id"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not remove a stale lock with a live recovery winner", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), "2147483647:stale-owner");
    fs.writeFileSync(path.join(lockPath, "recovery"), `${process.pid}:active-recovery`);
    fs.utimesSync(lockPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    fs.utimesSync(path.join(lockPath, "recovery"), new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));

    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      () => { throw new Error("must not deliver while another owner holds the lock"); },
    );

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("cancels a lock retry when the watcher stops", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}:other-token`);
    fs.writeFileSync(path.join(inbox, "stopped.json"), JSON.stringify({
      id: "stopped-id",
      from: "Peer",
      to: "Self",
      text: "do not retry",
    }));

    const delivered: string[] = [];
    const state = { agentName: "Self", registered: true, watcher: null } as MessengerState;
    processAllPendingMessages(state, dirs, msg => delivered.push(msg.id));
    stopWatcher(state);
    fs.rmSync(lockPath, { recursive: true, force: true });
    vi.advanceTimersByTime(10_000);

    expect(delivered).toEqual([]);
    expect(fs.existsSync(path.join(inbox, "stopped.json"))).toBe(true);
  });

  it("does not remove a new owner lock after stale recovery", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), "2147483647:stale-token");
    fs.utimesSync(lockPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));

    const state = { agentName: "Self", registered: true } as MessengerState;
    processAllPendingMessages(state, dirs, () => { throw new Error("must not deliver"); });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}:new-token`);

    vi.advanceTimersByTime(10_000);
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf-8")).toBe(`${process.pid}:new-token`);
  });

  it("ignores abandoned lock initialization staging when a canonical owner exists", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    const stagingPath = path.join(ledger, ".lock-start-abandoned");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.mkdirSync(stagingPath, { recursive: true });
    fs.utimesSync(stagingPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}:canonical-owner`);
    fs.writeFileSync(path.join(inbox, "staged-lock.json"), JSON.stringify({
      id: "staged-lock-id",
      from: "Peer",
      to: "Self",
      text: "canonical owner must survive",
    }));

    const delivered: string[] = [];
    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      msg => delivered.push(msg.id),
    );

    expect(delivered).toEqual([]);
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf-8")).toBe(`${process.pid}:canonical-owner`);
    expect(fs.existsSync(stagingPath)).toBe(true);
  });

  it("keeps a live owner in a stale-looking lock directory", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}:published-owner`);
    fs.utimesSync(lockPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));

    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      () => { throw new Error("must not deliver while the live owner holds the lock"); },
    );

    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf-8")).toBe(`${process.pid}:published-owner`);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("returns immediately on a lock miss and retries without blocking", () => {
    vi.useFakeTimers();
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    const lockPath = path.join(ledger, ".lock");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}:other-token`);
    fs.writeFileSync(path.join(inbox, "timer.json"), JSON.stringify({
      id: "timer-id",
      from: "Peer",
      to: "Self",
      text: "retry later",
    }));

    const delivered: string[] = [];
    const state = { agentName: "Self", registered: true } as MessengerState;
    processAllPendingMessages(state, dirs, msg => delivered.push(msg.id));
    expect(delivered).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);

    vi.advanceTimersByTime(9_999);
    expect(delivered).toEqual([]);
    fs.rmSync(lockPath, { recursive: true, force: true });
    vi.advanceTimersByTime(1);

    expect(delivered).toEqual(["timer-id"]);
  });

  it("normalizes message and ts fields before delivery", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const timestamp = "2026-08-23T12:00:00.000Z";
    fs.writeFileSync(path.join(inbox, "1.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      message: "Historical body",
      ts: timestamp,
      replyTo: 123,
    }));

    const delivered: Array<{ text: string; timestamp: string }> = [];

    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      msg => delivered.push(msg),
    );

    expect(delivered).toEqual([
      {
        id: "1",
        from: "Peer",
        to: "Self",
        text: "Historical body",
        timestamp,
        replyTo: null,
      },
    ]);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });

  it("writes inbox messages atomically and binds them to the current target session", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    writeRegistration(dirs.registry, "Peer", process.cwd());

    const msg = sendMessageToAgent(
      { agentName: "Self" } as MessengerState,
      dirs,
      "Peer",
      "Atomic body",
    );
    const inbox = path.join(dirs.inbox, "Peer");
    const files = fs.readdirSync(inbox);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect(JSON.parse(fs.readFileSync(path.join(inbox, files[0]), "utf-8"))).toMatchObject({
      id: msg.id,
      text: "Atomic body",
      targetSessionId: "session-1",
    });
  });

  it("delivers duplicate message ids once across duplicate files and reprocessing", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const message = {
      id: "stable-message-id",
      from: "Peer",
      to: "Self",
      text: "Deliver once",
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(inbox, "first.json"), JSON.stringify(message));
    fs.writeFileSync(path.join(inbox, "second.json"), JSON.stringify(message));
    const state = { agentName: "Self", registered: true } as MessengerState;
    const delivered: string[] = [];

    processAllPendingMessages(state, dirs, msg => delivered.push(msg.id));
    processAllPendingMessages(state, dirs, msg => delivered.push(msg.id));

    expect(delivered).toEqual(["stable-message-id"]);
    expect(fs.readdirSync(inbox)).toEqual([]);
    const ledger = path.join(dirs.base, "processed", "Self");
    expect(fs.readdirSync(ledger)).toHaveLength(1);
    expect(fs.readdirSync(dirs.inbox)).toEqual(["Self"]);
  });

  it("uses the marker before unlink when a delivered source file is left behind", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const messagePath = path.join(inbox, "leftover.json");
    fs.writeFileSync(messagePath, JSON.stringify({
      id: "leftover-message-id",
      from: "Peer",
      to: "Self",
      text: "Leave source behind",
    }));
    const state = { agentName: "Self", registered: true } as MessengerState;
    let deliveries = 0;
    const movedSourcePath = `${messagePath}.leftover`;
    processAllPendingMessages(state, dirs, () => {
      deliveries++;
      // Replace the source path after delivery. The real unlink then fails on a
      // directory, without redefining the ESM fs namespace.
      fs.renameSync(messagePath, movedSourcePath);
      fs.mkdirSync(messagePath);
    });
    expect(deliveries).toBe(1);
    expect(fs.statSync(messagePath).isDirectory()).toBe(true);

    // Restore the source before the next pass. The marker was already durable,
    // so recovery removes it without redelivering.
    fs.rmSync(messagePath, { recursive: true });
    fs.renameSync(movedSourcePath, messagePath);
    processAllPendingMessages(state, dirs, () => { deliveries++; });
    expect(deliveries).toBe(1);
    expect(fs.existsSync(messagePath)).toBe(false);
  });

  it("keeps a non-string timestamp out of the durable fingerprint", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const messagePath = path.join(inbox, "non-string-timestamp.json");
    fs.writeFileSync(messagePath, JSON.stringify({
      id: "non-string-timestamp-id",
      from: "Peer",
      to: "Self",
      text: "Stable payload",
      timestamp: 12345,
    }));
    const state = { agentName: "Self", registered: true } as MessengerState;
    let deliveries = 0;
    const leftoverPath = `${messagePath}.leftover`;

    processAllPendingMessages(state, dirs, () => {
      deliveries++;
      fs.renameSync(messagePath, leftoverPath);
      fs.mkdirSync(messagePath);
    });
    fs.rmSync(messagePath, { recursive: true });
    fs.renameSync(leftoverPath, messagePath);
    processAllPendingMessages({ agentName: "Self", registered: true } as MessengerState, dirs, () => {
      deliveries++;
    });

    expect(deliveries).toBe(1);
    expect(fs.existsSync(messagePath)).toBe(false);
  });

  it("durably pauses a message when both quarantine paths fail", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const messagePath = path.join(inbox, "pause.json");
    fs.writeFileSync(messagePath, JSON.stringify({ from: "Peer", to: "Self", text: "Pause me" }));
    fs.mkdirSync(`${messagePath}.retry`);
    processAllPendingMessages({ agentName: "Self", registered: true } as MessengerState, dirs, () => {
      fs.unlinkSync(messagePath);
      throw new Error("permanent failure");
    });

    const pausedDir = path.join(dirs.base, "paused", "Self");
    expect(fs.readdirSync(pausedDir)).toHaveLength(1);
    const pauseRecord = JSON.parse(fs.readFileSync(path.join(pausedDir, fs.readdirSync(pausedDir)[0]), "utf-8"));
    expect(pauseRecord).toMatchObject({ messageId: "pause", messagePath });
    fs.writeFileSync(messagePath, JSON.stringify({ from: "Peer", to: "Self", text: "Pause me" }));
    let deliveries = 0;
    processAllPendingMessages({ agentName: "Self", registered: true } as MessengerState, dirs, () => {
      deliveries++;
    });
    expect(deliveries).toBe(0);
    expect(fs.existsSync(messagePath)).toBe(true);
  });

  it("retains the source when processed marker persistence fails", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const messagePath = path.join(inbox, "marker-failure.json");
    fs.writeFileSync(messagePath, JSON.stringify({
      id: "marker-failure-id",
      from: "Peer",
      to: "Self",
      text: "Marker must persist",
    }));
    const state = { agentName: "Self", registered: true } as MessengerState;
    let deliveries = 0;
    const ledger = path.join(dirs.base, "processed", "Self");
    const markerName = `${createHash("sha256").update("marker-failure-id", "utf8").digest("hex")}.json`;

    processAllPendingMessages(state, dirs, () => {
      deliveries++;
      fs.mkdirSync(ledger, { recursive: true });
      // Create the destination after the marker check, so atomic rename fails
      // only when acknowledgement is persisted.
      fs.mkdirSync(path.join(ledger, markerName));
    });
    expect(deliveries).toBe(1);
    expect(fs.existsSync(messagePath)).toBe(true);
  });

  it("quarantines a same-id message whose payload fingerprint conflicts", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const message = { id: "conflicting-id", from: "Peer", to: "Self", text: "first" };
    fs.writeFileSync(path.join(inbox, "first.json"), JSON.stringify(message));
    fs.writeFileSync(path.join(inbox, "second.json"), JSON.stringify({ ...message, text: "different" }));
    const state = { agentName: "Self", registered: true } as MessengerState;
    const delivered: string[] = [];

    processAllPendingMessages(state, dirs, msg => delivered.push(msg.text));

    expect(delivered).toEqual(["first"]);
    const quarantine = path.join(inbox, "quarantine");
    const reasonFiles = fs.readdirSync(quarantine).filter(file => file.endsWith(".reason"));
    expect(reasonFiles).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(quarantine, reasonFiles[0]), "utf-8")).reason)
      .toContain("processed message ID conflict");
  });

  it("fails closed for a legacy marker without a payload fingerprint", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    const ledger = path.join(dirs.base, "processed", "Self");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(ledger, { recursive: true });
    const message = { id: "legacy-id", from: "Peer", to: "Self", text: "legacy" };
    fs.writeFileSync(path.join(inbox, "legacy.json"), JSON.stringify(message));
    const markerName = `${createHash("sha256").update("legacy-id", "utf8").digest("hex")}.json`;
    fs.writeFileSync(path.join(ledger, markerName), JSON.stringify({ id: "legacy-id", processedAt: new Date().toISOString() }));
    const delivered: string[] = [];

    processAllPendingMessages({ agentName: "Self", registered: true } as MessengerState, dirs, msg => delivered.push(msg.id));

    expect(delivered).toEqual([]);
    expect(fs.existsSync(path.join(inbox, "legacy.json"))).toBe(false);
    const quarantine = path.join(inbox, "quarantine");
    const reasonFiles = fs.readdirSync(quarantine).filter(file => file.endsWith(".reason"));
    expect(JSON.parse(fs.readFileSync(path.join(quarantine, reasonFiles[0]), "utf-8")).reason)
      .toContain("legacy marker");
  });

  it("retains a failed delivery for retry and removes it after recovery", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "retry.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      text: "Retry me",
      timestamp: new Date().toISOString(),
    }));
    const state = { agentName: "Self", registered: true } as MessengerState;
    let shouldFail = true;

    processAllPendingMessages(state, dirs, () => {
      if (shouldFail) throw new Error("temporary failure");
    });
    expect(fs.existsSync(path.join(inbox, "retry.json"))).toBe(true);
    expect(fs.readFileSync(path.join(inbox, "retry.json.retry"), "utf-8")).toBe("1");

    shouldFail = false;
    processAllPendingMessages(state, dirs, () => undefined);
    expect(fs.existsSync(path.join(inbox, "retry.json"))).toBe(false);
    expect(fs.existsSync(path.join(inbox, "retry.json.retry"))).toBe(false);
  });

  it("quarantines permanently failing messages with durable evidence", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "bad.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      text: "Never deliver",
    }));
    const state = { agentName: "Self", registered: true } as MessengerState;

    for (let attempt = 0; attempt < 3; attempt++) {
      processAllPendingMessages(state, dirs, () => {
        throw new Error("permanent failure");
      });
    }

    expect(fs.existsSync(path.join(inbox, "bad.json"))).toBe(false);
    const quarantine = path.join(inbox, "quarantine");
    const quarantined = fs.readdirSync(quarantine);
    expect(quarantined.some(file => file.endsWith("-bad.json"))).toBe(true);
    const reasonFile = quarantined.find(file => file.endsWith("-bad.json.reason"));
    expect(reasonFile).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(quarantine, reasonFile!), "utf-8"))).toMatchObject({
      reason: "permanent failure",
    });
  });

  it("durably quarantines when the retry sidecar cannot be written", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "sidecar.json"), JSON.stringify({ from: "Peer", to: "Self", text: "Retry" }));
    fs.mkdirSync(path.join(inbox, "sidecar.json.retry"));
    const state = { agentName: "Self", registered: true } as MessengerState;

    processAllPendingMessages(state, dirs, () => { throw new Error("sidecar unavailable"); });

    expect(fs.existsSync(path.join(inbox, "sidecar.json"))).toBe(false);
    expect(fs.readdirSync(path.join(inbox, "quarantine"))).toHaveLength(2);
  });

  it("uses a non-JSON fallback dead letter when quarantine setup fails", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const messagePath = path.join(inbox, "dead-letter.json");
    fs.writeFileSync(messagePath, JSON.stringify({ from: "Peer", to: "Self", text: "Dead letter" }));
    fs.writeFileSync(path.join(inbox, "quarantine"), "not a directory");
    const state = { agentName: "Self", registered: true } as MessengerState;
    let deliveries = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      processAllPendingMessages(state, dirs, () => {
        deliveries++;
        throw new Error("permanent failure");
      });
    }

    const fallbackFiles = fs.readdirSync(inbox).filter(file => file.endsWith(".dead-letter"));
    expect(fallbackFiles).toHaveLength(1);
    const fallbackPath = path.join(inbox, fallbackFiles[0]);
    expect(fs.existsSync(messagePath)).toBe(false);
    expect(fs.existsSync(fallbackPath)).toBe(true);
    expect(fallbackPath.endsWith(".json")).toBe(false);
    expect(fs.existsSync(`${fallbackPath}.reason`)).toBe(true);

    processAllPendingMessages(state, dirs, () => { deliveries++; });
    expect(deliveries).toBe(3);
    expect(JSON.parse(fs.readFileSync(fallbackPath, "utf-8"))).toMatchObject({ text: "Dead letter" });
  });

  it("keeps registration JSON valid across create, update, and activity flush", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const state = createRegisterState(root);
    const ctx = {
      cwd: root,
      hasUI: false,
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => "session-1" },
    } as any;

    expect(register(state, dirs, ctx)).toBe(true);
    state.session.toolCalls = 2;
    updateRegistration(state, dirs, ctx);
    state.session.tokens = 7;
    flushActivityToRegistry(state, dirs, ctx);

    expect(fs.readdirSync(dirs.registry)).toEqual(["Self.json"]);
    expect(fs.readdirSync(dirs.registry).filter(file => file.includes(".tmp-"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dirs.registry, "Self.json"), "utf-8"))).toMatchObject({
      sessionId: "session-1",
      session: { toolCalls: 2, tokens: 7 },
    });
  });

  it("quarantines session-bound mail when the agent name is reused", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    writeRegistration(dirs.registry, "Self", process.cwd());
    fs.writeFileSync(path.join(inbox, "stale.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      text: "Stale message",
      targetSessionId: "old-session",
    }));

    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      () => { throw new Error("must not deliver stale mail"); },
    );

    expect(fs.existsSync(path.join(inbox, "stale.json"))).toBe(false);
    expect(fs.readdirSync(path.join(inbox, "quarantine"))).toHaveLength(2);
  });
});
