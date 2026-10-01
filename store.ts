/**
 * Pi Messenger - File Storage Operations
 */

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentRegistration,
  type AgentMailMessage,
  type ReservationConflict,
  type MessengerState,
  type Dirs,
  type ClaimEntry,
  type CompletionEntry,
  type SpecClaims,
  type SpecCompletions,
  type AllClaims,
  type AllCompletions,
  type NameThemeConfig,
  MAX_WATCHER_RETRIES,
  isProcessAlive,
  normalizeAgentMailMessage,
  generateMemorableName,
  isValidAgentName,
  pathMatchesReservation,
} from "./lib.ts";

// =============================================================================
// Agents Cache (Fix 1: Reduce disk I/O)
// =============================================================================

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;  // keyed by excluded agent name
  timestamp: number;
  registryPath: string;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCache: AgentsCache | null = null;

export function invalidateAgentsCache(): void {
  agentsCache = null;
}

// =============================================================================
// Message Processing Guard (Fix 3: Prevent race conditions)
// =============================================================================

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MessengerState;
  dirs: Dirs;
  deliverFn: (msg: AgentMailMessage) => void;
} | null = null;

// =============================================================================
// File System Helpers
// =============================================================================

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

const LOCK_STALE_MS = 10000;
const MESSAGE_RETRY_LIMIT = 3;
// Processed markers are kept outside inbox directories, retained for 30 days, and capped at 1024 per inbox.
const PROCESSED_MARKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROCESSED_MARKERS = 1024;
const blockedInboxMessages = new WeakMap<MessengerState, string>();
const inboxLockRetryTimers = new WeakMap<MessengerState, ReturnType<typeof setTimeout>>();

function writeJsonAtomically(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

/** Write an inbox message without exposing a partially-written final JSON file. */
export function writeInboxMessageAtomically(filePath: string, message: unknown): void {
  writeJsonAtomically(filePath, message);
}

/** Write only when the target has a readable, non-empty current session identity. */
export function writeTargetInboxMessageAtomically(
  filePath: string,
  message: Record<string, unknown>,
  to: string,
  dirs: Pick<Dirs, "registry">,
): boolean {
  const target = lookupTargetSession(to, dirs.registry);
  if (target.status !== "available") return false;
  writeJsonAtomically(filePath, { ...message, targetSessionId: target.sessionId });
  return true;
}

async function withSwarmLock<T>(baseDir: string, fn: () => T): Promise<T> {
  const lockPath = join(baseDir, "swarm.lock");
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
          if (!pid || !isProcessAlive(pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Lock doesn't exist
    }

    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (i === maxRetries - 1) {
          throw new Error("Failed to acquire swarm lock");
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }
}

// =============================================================================
// Registry Operations
// =============================================================================

export function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

export function getActiveAgents(state: MessengerState, dirs: Dirs): AgentRegistration[] {
  const now = Date.now();
  const excludeName = state.agentName;
  const myCwd = normalizeCwd(state.cwd);
  const scopeToFolder = state.scopeToFolder;

  // Cache key includes scopeToFolder and cwd for proper cache invalidation
  const cacheKey = scopeToFolder ? `${excludeName}:${myCwd}` : excludeName;

  // Return cached if valid (Fix 1)
  if (
    agentsCache &&
    agentsCache.registryPath === dirs.registry &&
    now - agentsCache.timestamp < AGENTS_CACHE_TTL_MS
  ) {
    // Check if we have a cached filtered result for this cache key
    const cachedFiltered = agentsCache.filtered.get(cacheKey);
    if (cachedFiltered) return cachedFiltered;

    // Create and cache filtered result
    let filtered = agentsCache.allAgents.filter(a => a.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter(a => a.cwd === myCwd);
    }
    agentsCache.filtered.set(cacheKey, filtered);
    return filtered;
  }

  // Read from disk
  const allAgents: AgentRegistration[] = [];

  if (!fs.existsSync(dirs.registry)) {
    agentsCache = { allAgents, filtered: new Map(), timestamp: now, registryPath: dirs.registry };
    return allAgents;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirs.registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), "utf-8");
      const reg: AgentRegistration = JSON.parse(content);

      if (!isProcessAlive(reg.pid)) {
        try {
          fs.unlinkSync(join(dirs.registry, file));
        } catch {
          // Ignore cleanup errors
        }
        continue;
      }

      if (reg.session === undefined) {
        reg.session = { toolCalls: 0, tokens: 0, filesModified: [] };
      }
      if (reg.activity === undefined) {
        reg.activity = { lastActivityAt: reg.startedAt };
      }
      if (reg.isHuman === undefined) {
        reg.isHuman = false;
      }
      reg.cwd = normalizeCwd(reg.cwd);
      allAgents.push(reg);
    } catch {
      // Ignore malformed registrations
    }
  }

  // Cache the full list and create filtered result
  let filtered = allAgents.filter(a => a.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter(a => a.cwd === myCwd);
  }
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(cacheKey, filtered);

  agentsCache = { allAgents, filtered: filteredMap, timestamp: now, registryPath: dirs.registry };

  return filtered;
}

export function findAvailableName(baseName: string, dirs: Dirs): string | null {
  const basePath = join(dirs.registry, `${baseName}.json`);
  if (!fs.existsSync(basePath)) return baseName;

  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    if (!isProcessAlive(existing.pid) || existing.pid === process.pid) {
      return baseName;
    }
  } catch {
    return baseName;
  }

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    const altPath = join(dirs.registry, `${altName}.json`);

    if (!fs.existsSync(altPath)) return altName;

    try {
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, "utf-8"));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
}

export function register(state: MessengerState, dirs: Dirs, ctx: ExtensionContext, nameTheme?: NameThemeConfig): boolean {
  if (state.registered) return true;

  ensureDirSync(dirs.registry);

  if (!state.agentName) {
    state.agentName = generateMemorableName(nameTheme);
  }

  const isExplicitName = !!process.env.PI_AGENT_NAME;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Validate and find available name
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent name "${state.agentName}" already in use (PID ${existing.pid})`, "error");
            }
            return false;
          }
        } catch {
          // Malformed, proceed to overwrite
        }
      }
    } else {
      const availableName = findAvailableName(state.agentName, dirs);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
        }
        return false;
      }
      state.agentName = availableName;
    }

    const regPath = getRegistrationPath(state, dirs);
    ensureDirSync(getMyInbox(state, dirs));

    const cwd = normalizeCwd(ctx.cwd);
    const gitBranch = getGitBranch(cwd);
    const now = new Date().toISOString();
    const registration: AgentRegistration = {
      name: state.agentName,
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      model: ctx.model?.id ?? "unknown",
      startedAt: now,
      gitBranch,
      spec: state.spec,
      isHuman: state.isHuman,
      session: { ...state.session },
      activity: { lastActivityAt: now },
    };

    try {
      writeJsonAtomically(regPath, registration);
    } catch (err) {
      if (ctx.hasUI) {
        const msg = err instanceof Error ? err.message : "unknown error";
        ctx.ui.notify(`Failed to register: ${msg}`, "error");
      }
      return false;
    }

    let verified = false;
    let verifyError = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      verified = written.pid === process.pid;
    } catch {
      verifyError = true;
    }

    if (verified) {
      state.registered = true;
      state.model = ctx.model?.id ?? "unknown";
      state.cwd = cwd;
      state.gitBranch = gitBranch;
      state.activity.lastActivityAt = now;
      invalidateAgentsCache();
      return true;
    }

    // Verification failed - clean up our write attempt if file still contains our data
    // (handles I/O error case where we wrote successfully but couldn't read back)
    if (verifyError) {
      try {
        const checkContent = fs.readFileSync(regPath, "utf-8");
        const checkReg: AgentRegistration = JSON.parse(checkContent);
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(regPath);
        }
      } catch {
        // Best effort cleanup
      }
    }

    // Another agent claimed this name - retry with fresh lookup (auto-generated only)
    if (isExplicitName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, "error");
      }
      return false;
    }
    invalidateAgentsCache();
  }

  // Exhausted retries
  if (ctx.hasUI) {
    ctx.ui.notify("Failed to register after multiple attempts due to name conflicts", "error");
  }
  return false;
}

export function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    const currentModel = ctx.model?.id ?? reg.model;
    reg.model = currentModel;
    state.model = currentModel;
    reg.cwd = state.cwd;
    reg.reservations = state.reservations.length > 0 ? state.reservations : undefined;
    if (state.spec) {
      reg.spec = state.spec;
    } else {
      delete reg.spec;
    }
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    writeJsonAtomically(regPath, reg);
  } catch {
    // Ignore errors
  }
}

export function flushActivityToRegistry(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    const currentModel = ctx.model?.id ?? reg.model;
    reg.model = currentModel;
    state.model = currentModel;
    reg.cwd = state.cwd;
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    writeJsonAtomically(regPath, reg);
  } catch {
    // Ignore errors
  }
}

export function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  try {
    fs.unlinkSync(regPath);
  } catch (error) {
    if (fs.existsSync(regPath)) {
      throw error;
    }
  }

  state.registered = false;
  invalidateAgentsCache();
}

export type RenameResult =
  | { success: true; oldName: string; newName: string }
  | { success: false; error: "not_registered" | "invalid_name" | "name_taken" | "same_name" | "race_lost" };

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered) {
    return { success: false, error: "not_registered" };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: "invalid_name" };
  }

  if (newName === state.agentName) {
    return { success: false, error: "same_name" };
  }

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: "name_taken" };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);
  const oldInbox = getMyInbox(state, dirs);
  const newInbox = join(dirs.inbox, newName);

  processAllPendingMessages(state, dirs, deliverFn);

  const cwd = normalizeCwd(ctx.cwd);
  const gitBranch = getGitBranch(cwd);
  const now = new Date().toISOString();
  const registration: AgentRegistration = {
    name: newName,
    pid: process.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd,
    model: ctx.model?.id ?? "unknown",
    startedAt: now,
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    gitBranch,
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { lastActivityAt: now },
    statusMessage: state.statusMessage,
  };

  ensureDirSync(dirs.registry);
  
  try {
    writeJsonAtomically(join(dirs.registry, `${newName}.json`), registration);
  } catch (err) {
    return { success: false, error: "invalid_name" as const };
  }

  // Verify we own the new registration (guards against race condition)
  let verified = false;
  let verifyError = false;
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
    verified = written.pid === process.pid;
  } catch {
    verifyError = true;
  }

  if (!verified) {
    // Clean up our write attempt if file still contains our data (I/O error case)
    if (verifyError) {
      try {
        const checkReg: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(newRegPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
    return { success: false, error: "race_lost" };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;

  if (fs.existsSync(newInbox)) {
    try {
      const staleFiles = fs.readdirSync(newInbox).filter(f => f.endsWith(".json"));
      for (const file of staleFiles) {
        try {
          fs.unlinkSync(join(newInbox, file));
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }
  ensureDirSync(newInbox);

  try {
    fs.rmdirSync(oldInbox);
  } catch {
    // Ignore - might have new messages or not exist
  }

  state.model = ctx.model?.id ?? "unknown";
  state.cwd = cwd;
  state.gitBranch = gitBranch;
  state.sessionStartedAt = now;
  state.activity.lastActivityAt = now;
  invalidateAgentsCache();
  return { success: true, oldName, newName };
}

export function getConflictsWithOtherAgents(
  filePath: string,
  state: MessengerState,
  dirs: Dirs
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const agents = getActiveAgents(state, dirs);

  for (const agent of agents) {
    if (!agent.reservations) continue;
    for (const res of agent.reservations) {
      if (pathMatchesReservation(filePath, res.pattern)) {
        conflicts.push({
          path: filePath,
          agent: agent.name,
          pattern: res.pattern,
          reason: res.reason,
          registration: agent
        });
      }
    }
  }

  return conflicts;
}

// =============================================================================
// Swarm Coordination
// =============================================================================

const CLAIMS_FILE = "claims.json";
const COMPLETIONS_FILE = "completions.json";

function readClaimsSync(dirs: Dirs): AllClaims {
  const path = join(dirs.base, CLAIMS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllClaims;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function readCompletionsSync(dirs: Dirs): AllCompletions {
  const path = join(dirs.base, COMPLETIONS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllCompletions;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function writeClaimsSync(dirs: Dirs, claims: AllClaims): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, CLAIMS_FILE);
  const temp = join(dirs.base, `${CLAIMS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(claims, null, 2));
  fs.renameSync(temp, target);
}

function writeCompletionsSync(dirs: Dirs, completions: AllCompletions): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, COMPLETIONS_FILE);
  const temp = join(dirs.base, `${COMPLETIONS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(completions, null, 2));
  fs.renameSync(temp, target);
}

function isClaimStale(claim: ClaimEntry, dirs: Dirs): boolean {
  if (!isProcessAlive(claim.pid)) return true;
  const regPath = join(dirs.registry, `${claim.agent}.json`);
  if (!fs.existsSync(regPath)) return true;
  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!isProcessAlive(reg.pid)) return true;
    if (reg.sessionId !== claim.sessionId) return true;
  } catch {
    return true;
  }
  return false;
}

function cleanupStaleClaims(claims: AllClaims, dirs: Dirs): number {
  let removed = 0;
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (isClaimStale(claim, dirs)) {
        delete tasks[taskId];
        removed++;
      }
    }
    if (Object.keys(tasks).length === 0) {
      delete claims[spec];
    }
  }
  return removed;
}

function filterStaleClaims(claims: AllClaims, dirs: Dirs): AllClaims {
  const filtered: AllClaims = {};
  for (const [spec, tasks] of Object.entries(claims)) {
    const filteredTasks: SpecClaims = {};
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (!isClaimStale(claim, dirs)) {
        filteredTasks[taskId] = claim;
      }
    }
    if (Object.keys(filteredTasks).length > 0) {
      filtered[spec] = filteredTasks;
    }
  }
  return filtered;
}

function findAgentClaim(claims: AllClaims, agent: string): { spec: string; taskId: string } | null {
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId };
      }
    }
  }
  return null;
}

export function getClaims(dirs: Dirs): AllClaims {
  const claims = readClaimsSync(dirs);
  return filterStaleClaims(claims, dirs);
}

export function getClaimsForSpec(dirs: Dirs, specPath: string): SpecClaims {
  const claims = getClaims(dirs);
  return claims[specPath] ?? {};
}

export function getCompletions(dirs: Dirs): AllCompletions {
  return readCompletionsSync(dirs);
}

export function getCompletionsForSpec(dirs: Dirs, specPath: string): SpecCompletions {
  const completions = getCompletions(dirs);
  return completions[specPath] ?? {};
}

export function getAgentCurrentClaim(
  dirs: Dirs,
  agent: string
): { spec: string; taskId: string; reason?: string } | null {
  const claims = getClaims(dirs);
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId, reason: claim.reason };
      }
    }
  }
  return null;
}

export type ClaimResult =
  | { success: true; claimedAt: string }
  | { success: false; error: "already_claimed"; conflict: ClaimEntry }
  | { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } };

export function isClaimSuccess(r: ClaimResult): r is { success: true; claimedAt: string } {
  return r.success === true;
}
export function isClaimAlreadyClaimed(r: ClaimResult): r is { success: false; error: "already_claimed"; conflict: ClaimEntry } {
  return "error" in r && r.error === "already_claimed";
}
export function isClaimAlreadyHaveClaim(r: ClaimResult): r is { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } } {
  return "error" in r && r.error === "already_have_claim";
}

export async function claimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  sessionId: string,
  pid: number,
  reason?: string
): Promise<ClaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existing = findAgentClaim(claims, agent);
    if (existing) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_have_claim", existing };
    }

    const existingClaim = claims[specPath]?.[taskId];
    if (existingClaim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_claimed", conflict: existingClaim };
    }

    if (!claims[specPath]) claims[specPath] = {};
    const newClaim: ClaimEntry = {
      agent,
      sessionId,
      pid,
      claimedAt: new Date().toISOString(),
      reason
    };
    claims[specPath][taskId] = newClaim;
    writeClaimsSync(dirs, claims);
    return { success: true, claimedAt: newClaim.claimedAt };
  });
}

export type UnclaimResult =
  | { success: true }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string };

export function isUnclaimSuccess(r: UnclaimResult): r is { success: true } {
  return r.success === true;
}
export function isUnclaimNotYours(r: UnclaimResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function unclaimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string
): Promise<UnclaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }
    writeClaimsSync(dirs, claims);
    return { success: true };
  });
}

export type CompleteResult =
  | { success: true; completedAt: string }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string }
  | { success: false; error: "already_completed"; completion: CompletionEntry };

export function isCompleteSuccess(r: CompleteResult): r is { success: true; completedAt: string } {
  return r.success === true;
}
export function isCompleteAlreadyCompleted(r: CompleteResult): r is { success: false; error: "already_completed"; completion: CompletionEntry } {
  return "error" in r && r.error === "already_completed";
}
export function isCompleteNotYours(r: CompleteResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function completeTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  notes?: string
): Promise<CompleteResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const completions = readCompletionsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existingCompletion = completions[specPath]?.[taskId];
    if (existingCompletion) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_completed", completion: existingCompletion };
    }

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }

    if (!completions[specPath]) completions[specPath] = {};
    const completion: CompletionEntry = {
      completedBy: agent,
      completedAt: new Date().toISOString(),
      notes
    };
    completions[specPath][taskId] = completion;

    // Write completions first - if claims write fails, we at least have the completion
    // recorded (the important part). The stale claim will be cleaned up eventually.
    writeCompletionsSync(dirs, completions);
    writeClaimsSync(dirs, claims);
    return { success: true, completedAt: completion.completedAt };
  });
}

// =============================================================================
// Messaging Operations
// =============================================================================

export function getMyInbox(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.agentName);
}

function retryMetadataPath(msgPath: string): string {
  return `${msgPath}.retry`;
}

function processedLedgerPath(inbox: string): string {
  // Keep the ledger beside the shared inbox directory, not inside an inbox scan root.
  return join(dirname(dirname(inbox)), "processed", basename(inbox));
}

function processedMarkerPath(ledgerPath: string, messageId: string): string {
  const key = createHash("sha256").update(messageId, "utf8").digest("hex");
  return join(ledgerPath, `${key}.json`);
}

function messagePayloadFingerprint(msg: AgentMailMessage, timestampProvided = true): string {
  // Keep the digest input explicit and stable: normalization makes equivalent legacy
  // inbox records produce the same payload while excluding filesystem metadata. A
  // generated timestamp is deliberately omitted, otherwise identical legacy records
  // would conflict merely because they were scanned at different times.
  const payload = JSON.stringify({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    text: msg.text,
    ...(timestampProvided ? { timestamp: msg.timestamp } : {}),
    replyTo: msg.replyTo,
    ...(msg.targetSessionId ? { targetSessionId: msg.targetSessionId } : {}),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

type ProcessedMarkerStatus = "missing" | "same" | "conflict" | "legacy";

function getProcessedMarkerStatus(
  ledgerPath: string,
  messageId: string,
  fingerprint: string,
): ProcessedMarkerStatus {
  const markerPath = processedMarkerPath(ledgerPath, messageId);
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      id?: unknown;
      payloadFingerprint?: unknown;
    };
    if (marker.id !== messageId) {
      throw new Error(`processed marker identity mismatch for ${messageId}`);
    }
    if (typeof marker.payloadFingerprint !== "string") return "legacy";
    return marker.payloadFingerprint === fingerprint ? "same" : "conflict";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

interface InboxLock {
  path: string;
  token: string;
}

function tryRecoverStaleInboxLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return;

    let pid = 0;
    try {
      const owner = fs.readFileSync(join(lockPath, "owner"), "utf-8").split(":", 1)[0];
      pid = Number.parseInt(owner, 10);
    } catch {
      // A stale lock with no readable owner is safe to recover.
    }
    if (pid && isProcessAlive(pid)) return;

    // Recovery itself is serialized by a fixed marker inside the old lock.
    // Only the marker creator, or the one process that atomically claims a
    // dead marker and installs a replacement marker, may rename the lock.
    const markerPath = join(lockPath, "recovery");
    const markerToken = `${process.pid}:${randomUUID()}`;
    let recoveryPath = markerPath;
    try {
      fs.writeFileSync(markerPath, markerToken, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
      let markerStat: fs.Stats;
      let existingToken: string;
      try {
        markerStat = fs.statSync(markerPath);
        existingToken = fs.readFileSync(markerPath, "utf-8");
      } catch {
        // The prior recovery marker disappeared; the next retry can compete.
        return;
      }
      if (Date.now() - markerStat.mtimeMs <= LOCK_STALE_MS) return;
      const markerPid = Number.parseInt(existingToken.split(":", 1)[0], 10);
      if (markerPid && isProcessAlive(markerPid)) return;

      // Claim a dead marker atomically. If another process wins this rename,
      // it is the only process allowed to continue with the old lock.
      const claimedMarkerPath = `${markerPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        fs.renameSync(markerPath, claimedMarkerPath);
        if (fs.readFileSync(claimedMarkerPath, "utf-8") !== existingToken) return;
        fs.writeFileSync(markerPath, markerToken, { mode: 0o600, flag: "wx" });
        recoveryPath = markerPath;
      } catch {
        try { fs.unlinkSync(claimedMarkerPath); } catch { /* Best effort. */ }
        return;
      }
    }

    // Re-check identity after winning recovery. A contender may have already
    // renamed the old directory and installed a new .lock while this process
    // was reading the old entry. Never rename a different inode.
    let currentStat: fs.Stats;
    try {
      currentStat = fs.statSync(lockPath);
    } catch {
      try { fs.unlinkSync(recoveryPath); } catch { /* Best effort. */ }
      return;
    }
    if (currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
      try {
        if (fs.readFileSync(recoveryPath, "utf-8") === markerToken) fs.unlinkSync(recoveryPath);
      } catch {
        // The marker moved with the claimed old directory or was already removed.
      }
      return;
    }

    const claimedPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, claimedPath);
    } catch {
      // Another recovery winner claimed the lock, or a new owner was installed.
      try {
        if (fs.readFileSync(recoveryPath, "utf-8") === markerToken) fs.unlinkSync(recoveryPath);
      } catch {
        // The marker may have moved with another claimed directory.
      }
      return;
    }
    try {
      fs.rmSync(claimedPath, { recursive: true, force: true });
    } catch {
      // The claimed stale entry remains isolated from any current lock.
    }
    // recoveryPath and the marker are inside claimedPath, so the cleanup above
    // removes only the stale directory and cannot touch a new .lock.
  } catch {
    // The lock may have been released or replaced between operations.
  }
}

function acquireInboxLock(ledgerPath: string): InboxLock | null {
  try {
    ensureDirSync(ledgerPath);
  } catch {
    return null;
  }

  const lockPath = join(ledgerPath, ".lock");
  const token = `${process.pid}:${randomUUID()}`;
  try {
    // mkdir is the ownership operation: it keeps .lock occupied throughout
    // stale recovery and avoids a file replacement window.
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") tryRecoverStaleInboxLock(lockPath);
    return null;
  }

  try {
    fs.writeFileSync(join(lockPath, "owner"), token, { mode: 0o600, flag: "wx" });
    return { path: lockPath, token };
  } catch {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best effort cleanup if owner persistence failed.
    }
    return null;
  }
}

function releaseInboxLock(lock: InboxLock): void {
  try {
    const ownerPath = join(lock.path, "owner");
    if (fs.readFileSync(ownerPath, "utf-8") !== lock.token) return;
    // Remove the owner marker first, then remove only the now-empty directory.
    // A stale recovery can rename this directory between these operations, but
    // a new owner cannot install .lock until this directory is gone; rmdir
    // therefore cannot remove a replacement lock.
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lock.path);
  } catch {
    // A crashed or stale-lock recovery path may already have removed it.
  }
}

function pruneProcessedMarkers(ledgerPath: string): void {
  try {
    const now = Date.now();
    const entries = fs.readdirSync(ledgerPath)
      .filter(file => file.endsWith(".json"))
      .map(file => {
        const markerPath = join(ledgerPath, file);
        return { markerPath, mtimeMs: fs.statSync(markerPath).mtimeMs };
      });

    for (const entry of entries) {
      if (now - entry.mtimeMs > PROCESSED_MARKER_RETENTION_MS) {
        try {
          fs.unlinkSync(entry.markerPath);
        } catch {
          // Best effort retention cleanup.
        }
      }
    }

    const remaining = entries
      .filter(entry => fs.existsSync(entry.markerPath))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (remaining.length > MAX_PROCESSED_MARKERS) {
      const oldest = remaining.shift();
      if (!oldest) break;
      try {
        fs.unlinkSync(oldest.markerPath);
      } catch {
        // Best effort retention cleanup.
      }
    }
  } catch {
    // Marker persistence has already succeeded; cleanup must not make delivery less durable.
  }
}

function persistProcessedMarker(ledgerPath: string, msg: AgentMailMessage, payloadFingerprint: string): void {
  ensureDirSync(ledgerPath);
  writeJsonAtomically(processedMarkerPath(ledgerPath, msg.id), {
    id: msg.id,
    payloadFingerprint,
    processedAt: new Date().toISOString(),
  });
  pruneProcessedMarkers(ledgerPath);
}

function recordMessageFailure(msgPath: string): { attempts: number; persisted: boolean } {
  const retryPath = retryMetadataPath(msgPath);
  let persistedAttempts = 0;
  try {
    persistedAttempts = Number.parseInt(fs.readFileSync(retryPath, "utf-8"), 10) || 0;
  } catch {
    // First failure, or metadata was not readable.
  }

  const attempts = persistedAttempts + 1;
  try {
    fs.writeFileSync(retryPath, String(attempts), { mode: 0o600 });
    return { attempts, persisted: true };
  } catch {
    // A process-local count cannot safely survive a consumer restart. The caller
    // must quarantine or pause this message immediately instead of retrying it.
    return { attempts, persisted: false };
  }
}

function clearMessageFailure(msgPath: string): void {
  try {
    fs.unlinkSync(retryMetadataPath(msgPath));
  } catch {
    // No retry metadata is normal.
  }
}

function pausedLedgerPath(inbox: string): string {
  return join(dirname(dirname(inbox)), "paused", basename(inbox));
}

function pausedMessagePath(inbox: string, msgPath: string): string {
  const key = createHash("sha256").update(msgPath, "utf8").digest("hex");
  return join(pausedLedgerPath(inbox), `${key}.json`);
}

function isPausedInboxMessage(inbox: string, msgPath: string): boolean {
  try {
    return fs.existsSync(pausedMessagePath(inbox, msgPath));
  } catch {
    return false;
  }
}

function recordPausedInboxMessage(inbox: string, msgPath: string, messageId: string, reason: string): boolean {
  try {
    const ledger = pausedLedgerPath(inbox);
    ensureDirSync(ledger);
    writeJsonAtomically(pausedMessagePath(inbox, msgPath), {
      messagePath: msgPath,
      messageId,
      reason,
      pausedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

function quarantineMessage(msgPath: string, reason: string): boolean {
  const quarantineName = `${Date.now()}-${randomUUID()}-${basename(msgPath)}`;
  try {
    const quarantineDir = join(dirname(msgPath), "quarantine");
    ensureDirSync(quarantineDir);
    const destination = join(quarantineDir, quarantineName);
    fs.renameSync(msgPath, destination);
    clearMessageFailure(msgPath);
    try {
      writeJsonAtomically(`${destination}.reason`, {
        reason,
        quarantinedAt: new Date().toISOString(),
      });
    } catch {
      // The quarantined message remains durable even if its evidence sidecar cannot be written.
    }
    return true;
  } catch {
    // Fall back to a sibling dead-letter file whose suffix cannot be scanned as inbox JSON.
    const fallbackPath = `${msgPath}.quarantined-${quarantineName}.dead-letter`;
    try {
      fs.renameSync(msgPath, fallbackPath);
      clearMessageFailure(msgPath);
      try {
        writeJsonAtomically(`${fallbackPath}.reason`, {
          reason,
          quarantinedAt: new Date().toISOString(),
        });
      } catch {
        // The fallback message remains durable even if its evidence sidecar cannot be written.
      }
      return true;
    } catch {
      // Leave the original message in place if no durable quarantine is possible.
      return false;
    }
  }
}

export type TargetSessionLookup =
  | { status: "available"; sessionId: string }
  | { status: "missing" | "invalid" | "unreadable" };

/** Read the target registration once for all inbox producers and consumers. */
export function lookupTargetSession(to: string, registryDir: string): TargetSessionLookup {
  const registrationPath = join(registryDir, `${to}.json`);
  if (!fs.existsSync(registrationPath)) return { status: "missing" };
  try {
    const registration = JSON.parse(fs.readFileSync(registrationPath, "utf-8")) as Partial<AgentRegistration>;
    if (typeof registration.sessionId !== "string" || registration.sessionId.length === 0) {
      return { status: "invalid" };
    }
    return { status: "available", sessionId: registration.sessionId };
  } catch {
    return { status: "unreadable" };
  }
}

function checkTargetSession(msg: AgentMailMessage, dirs: Dirs): "not-bound" | "match" | "mismatch" | "unavailable" {
  if (!msg.targetSessionId) return "not-bound";
  const target = lookupTargetSession(msg.to, dirs.registry);
  if (target.status === "available") {
    return target.sessionId === msg.targetSessionId ? "match" : "mismatch";
  }
  return target.status === "missing" ? "mismatch" : "unavailable";
}

function scheduleInboxLockRetry(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void,
): void {
  if (inboxLockRetryTimers.has(state)) return;
  // Retry asynchronously after the stale threshold without blocking the
  // watcher or keeping the process alive on its own.
  const timer = setTimeout(() => {
    inboxLockRetryTimers.delete(state);
    processAllPendingMessages(state, dirs, deliverFn);
  }, LOCK_STALE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  inboxLockRetryTimers.set(state, timer);
}

function clearInboxLockRetry(state: MessengerState): void {
  const timer = inboxLockRetryTimers.get(state);
  if (timer) {
    clearTimeout(timer);
    inboxLockRetryTimers.delete(state);
  }
}

export function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;

  // Fix 3: Prevent concurrent processing
  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;
  let inboxLock: InboxLock | null = null;

  try {
    const inbox = getMyInbox(state, dirs);
    if (!fs.existsSync(inbox)) return;
    const processedLedger = processedLedgerPath(inbox);
    // This lock covers marker check, delivery, marker persistence, and source unlink.
    // A miss returns immediately; the unref'd retry timer handles stale owners.
    inboxLock = acquireInboxLock(processedLedger);
    if (!inboxLock) {
      scheduleInboxLockRetry(state, dirs, deliverFn);
      return;
    }
    clearInboxLockRetry(state);
    pruneProcessedMarkers(processedLedger);

    const blockedPath = blockedInboxMessages.get(state);
    if (blockedPath) {
      if (fs.existsSync(blockedPath)) return;
      clearMessageFailure(blockedPath);
      blockedInboxMessages.delete(state);
    }

    let files: string[];
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      let messageId = file.endsWith(".json") ? file.slice(0, -5) : file;
      if (isPausedInboxMessage(inbox, msgPath)) continue;
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        const raw = JSON.parse(content) as unknown;
        const msg = normalizeAgentMailMessage(raw, {
          id: messageId,
          from: "unknown",
          to: state.agentName,
          timestamp: new Date().toISOString(),
        });
        messageId = msg.id;
        const timestampProvided = Boolean(
          raw && typeof raw === "object" && !Array.isArray(raw) &&
          (typeof (raw as Record<string, unknown>).timestamp === "string" ||
            typeof (raw as Record<string, unknown>).ts === "string")
        );
        const fingerprint = messagePayloadFingerprint(msg, timestampProvided);
        const markerStatus = getProcessedMarkerStatus(processedLedger, msg.id, fingerprint);
        if (markerStatus === "same") {
          fs.unlinkSync(msgPath);
          clearMessageFailure(msgPath);
          continue;
        }
        if (markerStatus === "conflict") {
          if (!quarantineMessage(msgPath, `processed message ID conflict: payload fingerprint differs for ${msg.id}`)) {
            throw new Error(`processed message ID conflict could not be quarantined for ${msg.id}`);
          }
          continue;
        }
        if (markerStatus === "legacy") {
          if (!quarantineMessage(msgPath, `processed message ID conflict: legacy marker has no payload fingerprint for ${msg.id}`)) {
            throw new Error(`legacy processed marker conflict could not be quarantined for ${msg.id}`);
          }
          continue;
        }
        const targetSession = checkTargetSession(msg, dirs);
        if (targetSession === "mismatch") {
          if (!quarantineMessage(msgPath, "target session is no longer active for this agent name")) {
            throw new Error("target session mismatch could not be quarantined");
          }
          continue;
        }
        if (targetSession === "unavailable") {
          throw new Error("target registration is temporarily unreadable");
        }
        deliverFn(msg);
        // Persist the durable acknowledgement before unlinking the source message. If this fails,
        // the source remains retryable and no delivery is silently claimed as complete.
        persistProcessedMarker(processedLedger, msg, fingerprint);
        fs.unlinkSync(msgPath);
        clearMessageFailure(msgPath);
      } catch (error) {
        const failure = recordMessageFailure(msgPath);
        const reason = error instanceof Error ? error.message : "message read or delivery failed";
        // Without a durable sidecar, retry state would reset after a restart. Fail
        // closed by moving the message to durable quarantine immediately.
        if (!failure.persisted || failure.attempts >= MESSAGE_RETRY_LIMIT) {
          const quarantineReason = failure.persisted
            ? reason
            : `retry state could not be persisted; message paused: ${reason}`;
          if (!quarantineMessage(msgPath, quarantineReason)) {
            if (!recordPausedInboxMessage(inbox, msgPath, messageId, quarantineReason)) {
              blockedInboxMessages.set(state, msgPath);
              console.error(`Pi Messenger inbox paused: could not quarantine or persist pause for ${msgPath}: ${quarantineReason}`);
            } else {
              console.error(`Pi Messenger inbox paused durably: could not quarantine ${msgPath}: ${quarantineReason}`);
            }
            return;
          }
        }
        // Retain failures below the limit so a transient read/delivery error can recover.
      }
    }
  } finally {
    // The lock is intentionally released only after the complete inbox pass.
    if (inboxLock) releaseInboxLock(inboxLock);
    isProcessingMessages = false;

    // Re-process if new calls came in while we were processing
    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliverFn);
    }
  }
}

export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  to: string,
  text: string,
  replyTo?: string
): AgentMailMessage {
  const targetInbox = join(dirs.inbox, to);
  ensureDirSync(targetInbox);

  const targetSession = lookupTargetSession(to, dirs.registry);
  const targetSessionId = targetSession.status === "available"
    ? targetSession.sessionId
    : undefined;
  // Keep compatibility with callers that queue mail before registration exists.

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
    ...(targetSessionId ? { targetSessionId } : {}),
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  writeInboxMessageAtomically(msgFile, msg);

  return msg;
}

// =============================================================================
// Watcher
// =============================================================================

const WATCHER_DEBOUNCE_MS = 50;

export function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliverFn);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      // Fix 2: Debounce rapid events
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliverFn);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

export function stopWatcher(state: MessengerState): void {
  clearInboxLockRetry(state);
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
}

// =============================================================================
// Target Validation
// =============================================================================

export type TargetValidation =
  | { valid: true }
  | { valid: false; error: "invalid_name" | "not_found" | "not_active" | "invalid_registration" };

export function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: "invalid_name" };
  }

  const targetReg = join(dirs.registry, `${to}.json`);
  if (!fs.existsSync(targetReg)) {
    return { valid: false, error: "not_found" };
  }

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(targetReg, "utf-8"));
    if (!isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(targetReg);
      } catch {
        // Ignore cleanup errors
      }
      return { valid: false, error: "not_active" };
    }
  } catch {
    return { valid: false, error: "invalid_registration" };
  }

  return { valid: true };
}
