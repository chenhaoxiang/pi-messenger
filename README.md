# Pi Messenger

English | [中文](README.zh-CN.md)

File-based coordination for multiple Pi sessions sharing a project or workspace. This repository is the maintained `chenhaoxiang/pi-messenger` fork.

> Fork repository: <https://github.com/chenhaoxiang/pi-messenger>
>
> Use **pi-messenger** for shared presence, file reservations, activity feed, Crew task orchestration, and optional Team profiles. Use [pi-intercom](https://github.com/chenhaoxiang/pi-intercom) for targeted 1:1 conversations.

## Install this fork

```bash
pi install git:github.com/chenhaoxiang/pi-messenger@main
```

Restart Pi or run `/reload` after installation. Pin a reviewed commit for reproducible installs:

```bash
pi install git:github.com/chenhaoxiang/pi-messenger@<reviewed-commit>
```

No daemon or remote server is required. Shared coordination state is stored locally under `~/.pi/agent/messenger/`; project Crew state is stored under `.pi/messenger/` in the working directory.

## Quick start

Join the local mesh and inspect peers:

```ts
pi_messenger({ action: "join" })
pi_messenger({ action: "status" })
pi_messenger({ action: "feed" })
```

Reserve files before editing them:

```ts
pi_messenger({
  action: "reserve",
  paths: ["src/auth/"],
  reason: "Refactoring the authentication flow",
})
pi_messenger({ action: "send", to: "SwiftRaven", message: "The auth files are reserved." })
pi_messenger({ action: "release" })
```

`/messenger` opens the presence, activity, chat, and Crew overlay. Agents can also use the `pi_messenger` tool directly.

## What the fork provides

### Presence and messaging

- memorable agent names, current model/branch/cwd, lifecycle status, tool-call counts, and token usage;
- direct messages and broadcasts between sessions in the same coordination scope;
- durable activity feed entries for edits, commits, tests, messages, and task events;
- stuck-agent detection with explicit status and cleanup of dead registrations;
- optional `autoRegister` and path-scoped auto-registration.

### File reservations

- reserve a file or directory before making changes;
- write/edit tool calls are blocked when another live agent owns the reservation;
- reservations are released explicitly or during session/agent cleanup;
- stale owners are detected conservatively instead of silently taking over active work.

### Crew and Team

Crew turns a PRD, SPEC, DESIGN, or inline prompt into a dependency graph:

```ts
pi_messenger({ action: "plan" })
pi_messenger({ action: "work", autonomous: true })
pi_messenger({ action: "review", target: "task-1" })
```

Workers run in waves when dependencies are satisfied. Each completed task receives a review result (`SHIP`, `NEEDS_WORK`, or `MAJOR_RETHINK`). Team is an optional layer that adds roles, charter text, durable memory, reusable profiles, and approval gates for risk labels.

Built-in roles follow the pi-subagents vocabulary where possible: `planner`, `scout`, `researcher`, `worker`, `reviewer`, `delegate`, `oracle`, and `evidence-auditor`.

## Fork reliability guarantees

This fork hardens file-based delivery instead of pretending it is exactly-once messaging:

- inbox removal happens only after an atomic processed marker is written;
- markers contain a normalized payload fingerprint and reject same-ID/different-payload conflicts;
- deduplication is bounded retention, not permanent exactly-once delivery;
- inbox processing uses a stale-recoverable directory lock with serialized recovery claims;
- lock misses return promptly and schedule a bounded asynchronous retry;
- if retry metadata and quarantine paths both fail, a durable pause ledger prevents delivery after restart;
- malformed or legacy markers fail closed rather than being treated as proof of delivery;
- cleanup is best effort and bounded by marker age/count limits.

These rules protect against duplicate delivery, concurrent inbox consumers, stale locks, and restart-time message loss. They do not make the local filesystem a distributed transaction system.

## Crew skills and project state

Crew agents and the `pi-messenger-crew` skill are bundled with the extension. Domain-specific skills can be loaded on demand from:

1. `~/.pi/agent/skills/`;
2. the extension's `crew/skills/`;
3. the project's `.pi/messenger/crew/skills/`.

Crew logs and planning state are project-scoped:

```text
<project>/.pi/messenger/crew/
├── planning-progress.md
├── tasks.json
└── ...
```

To inspect or customize packaged agents:

```bash
npx pi-messenger --crew-install
npx pi-messenger --crew-uninstall
```

Project-level copies under `.pi/messenger/crew/agents/` override extension defaults by name.

## Configuration

Global configuration is normally read from:

```text
~/.pi/agent/pi-messenger.json
```

Project configuration can be placed under `.pi/messenger/` where the relevant feature supports it. Common settings include:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "autoOverlay": true,
  "crewEventsInFeed": true,
  "crew": {
    "models": {
      "worker": "anthropic/claude-haiku-4-5"
    }
  }
}
```

Crew workers inherit the host session model unless a task, role, frontmatter, or config override selects another model. Use explicit provider/model strings and thinking suffixes when a role needs a stable model contract.

## Safety boundaries

- Coordination is local and file-based; the extension does not claim remote delivery.
- A reservation is an advisory-to-enforced local write gate, not a substitute for Git review or filesystem permissions.
- Autonomous Crew work stops when tasks are complete, blocked, rejected, or the configured wave/attempt budget is reached.
- Approval-gated Team tasks remain blocked until explicitly approved.
- Messages and activity records may contain task text and file paths; keep the local state directory private.

## Development

```bash
npm install
npm test
```

Use disposable project directories for tests. Do not use production repositories, credentials, or private task history as fixtures.

## License

MIT
