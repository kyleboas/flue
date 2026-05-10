---
{
  "category": "sandbox",
  "website": "https://github.com/justbuildai/just-bash",
  "aliases": ["justbash"]
}
---

# Add a Flue Connector: just-bash

You are an AI coding agent installing the just-bash sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps [`just-bash`](https://github.com/justbuildai/just-bash) — an
in-process, virtual bash + filesystem written in pure TypeScript — into
Flue's `BashFactory` interface. Nothing is spawned, nothing is networked
against by default: shell commands are interpreted in-memory and the
filesystem lives in-process. This makes it the cheapest, fastest sandbox
for Flue agents, and the only one that requires no external service or
container runtime.

Things to know before installing:

- just-bash runs on both `--target node` and `--target cloudflare`. The
  same package works for either target.
- The default filesystem is `InMemoryFs` (lost on restart). just-bash
  also ships `ReadWriteFs` (host filesystem passthrough — Node only),
  `MountableFs` (compose multiple filesystems under different paths),
  and a few others. Pick the one that matches the agent's needs.
- Each call to the factory returns a *fresh* `Bash` instance. Share the
  `fs` object across calls inside the factory closure if you want files
  to persist across sessions; create a new `fs` per call if you want
  per-session isolation.
- just-bash includes an opt-in network layer
  (`network: { dangerouslyAllowFullInternetAccess: true }`) which lets
  in-sandbox commands like `curl` reach the real internet via the host's
  network stack. Enable only if the agent actually needs it — leaving
  it off is the safer default.
- just-bash can register custom commands (`gh`, `npm`, `git`, etc.) into
  the sandbox's `$PATH`. The connector exposes a `defineCommand(...)`
  helper for this so secrets needed by those CLIs (e.g. `GH_TOKEN`,
  `NPM_TOKEN`) stay on the host and aren't visible to the agent. See
  *Connecting external CLIs* below.
- `defineCommand` has three forms. The two pass-through forms shell out
  via Node's `child_process` and only work on `--target node`. The
  custom-executor form (`defineCommand('name', async (args) => ...)`)
  is target-agnostic and works on both Node and Cloudflare. The
  connector itself imports nothing target-specific at the top level —
  it's safe to drop into either kind of project.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/just-bash.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/just-bash.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`BashFactory` contract and is intentionally thin.

```ts
/**
 * just-bash connector for Flue.
 *
 * Wraps `just-bash` — an in-process virtual bash + filesystem — into
 * Flue's BashFactory interface. just-bash is the cheapest, fastest
 * sandbox available to Flue: no external service, no container, no
 * network calls (unless explicitly enabled). Filesystem and shell run
 * entirely in-process.
 *
 * @example In-memory filesystem (default; lost on restart)
 * ```typescript
 * import { justBash } from '../connectors/just-bash';
 *
 * const agent = await init({
 *   sandbox: justBash(),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Persistent in-memory filesystem (shared across sessions)
 * ```typescript
 * import { InMemoryFs } from 'just-bash';
 * import { justBash } from '../connectors/just-bash';
 *
 * const fs = new InMemoryFs();
 * const agent = await init({
 *   sandbox: justBash({ fs }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Host filesystem passthrough (Node only)
 * ```typescript
 * import { ReadWriteFs } from 'just-bash';
 * import { justBash } from '../connectors/just-bash';
 *
 * const agent = await init({
 *   sandbox: justBash({ fs: new ReadWriteFs('/some/host/dir') }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Allow real network access from inside the sandbox
 * ```typescript
 * const agent = await init({
 *   sandbox: justBash({
 *     network: { dangerouslyAllowFullInternetAccess: true },
 *   }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 *
 * @example Expose a privileged CLI (`gh`) without leaking its token to the agent
 * ```typescript
 * import { justBash, defineCommand } from '../connectors/just-bash';
 *
 * const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });
 * const npm = defineCommand('npm');
 *
 * const agent = await init({
 *   sandbox: justBash({ commands: [gh, npm] }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 */
// This file is target-agnostic by design. `node:*` modules are only loaded
// inside the pass-through forms of `defineCommand`, which throw a clear
// error if invoked on Cloudflare. Everything else here works on both Node
// and Cloudflare without modification.
import { Bash, InMemoryFs, type CustomCommand, type Filesystem } from 'just-bash';
import type { BashFactory } from '@flue/sdk/client';

export interface JustBashOptions {
	/**
	 * Filesystem implementation just-bash should use. Defaults to a fresh
	 * `InMemoryFs` per factory call (per-session isolation). Pass a shared
	 * `InMemoryFs` (or any other just-bash `Filesystem`) if you want files
	 * to persist across sessions backed by the same Workspace.
	 */
	fs?: Filesystem;

	/**
	 * Default working directory for shell commands. just-bash defaults to
	 * `/` if omitted.
	 */
	cwd?: string;

	/**
	 * Network configuration. just-bash blocks network access by default.
	 * Set `{ dangerouslyAllowFullInternetAccess: true }` to let
	 * in-sandbox commands (e.g. `curl`) reach the real internet via the
	 * host's network stack.
	 */
	network?: { dangerouslyAllowFullInternetAccess?: boolean };

	/**
	 * Custom commands registered into the sandbox's `$PATH`. Use
	 * `defineCommand(...)` to build entries. Available to every prompt,
	 * skill, and shell call for the lifetime of the agent.
	 */
	commands?: CustomCommand[];
}

/**
 * Create a Flue `BashFactory` backed by just-bash.
 *
 * Each call to the returned factory constructs a new `Bash` instance.
 * The `fs`, `network`, and `commands` options (if provided) are captured
 * in the closure so they're shared across sessions; pass a fresh `fs`
 * per factory call if you want per-session isolation instead.
 */
export function justBash(options: JustBashOptions = {}): BashFactory {
	return () =>
		new Bash({
			fs: options.fs ?? new InMemoryFs(),
			cwd: options.cwd,
			network: options.network,
			customCommands: options.commands,
		});
}

// ─── External CLIs (defineCommand) ───────────────────────────────────────────

/**
 * Options for pass-through commands (forms A and B of `defineCommand`).
 * Forwarded to Node's `child_process.execFile` at runtime. Typed loosely
 * here so this file doesn't need to import Node types at the top level —
 * the actual `child_process.ExecFileOptions` shape is enforced by Node
 * when the command runs.
 */
export interface CommandOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
	timeout?: number;
	maxBuffer?: number;
	[key: string]: unknown;
}

/**
 * User-supplied command executor (form C of `defineCommand`). Can return a
 * full `{ stdout, stderr, exitCode }`, a partial subset, a bare string
 * (treated as stdout), or void (empty success). Throws are caught and
 * surfaced as a non-zero exit code — no `try`/`catch` boilerplate required.
 */
export type CommandExecutor = (args: string[]) => Promise<
	| { stdout?: string; stderr?: string; exitCode?: number }
	| string
	| void
>;

/**
 * Names of essential, non-sensitive environment variables automatically
 * forwarded to pass-through commands (forms A and B) when running on Node.
 * Looked up from `process.env` at command-execute time, not at module load,
 * so this file stays import-safe on Cloudflare. Anything not listed here
 * (API keys, tokens, secrets, etc.) stays on the host and is NEVER exposed
 * to the spawned process unless the caller opts in explicitly via
 * `options.env`.
 *
 * If you need full control over the env, use the function form:
 * `defineCommand('gh', async (args) => { ... })`.
 */
const DEFAULT_ENV_KEYS = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'HOSTNAME',
	'SHELL',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TZ',
	'TERM',
	'TMPDIR',
	'TMP',
	'TEMP',
] as const;

interface ErrorLike {
	stdout?: unknown;
	stderr?: unknown;
	code?: unknown;
}

function normalizeExecutor(
	executor: CommandExecutor,
): (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return async (args) => {
		try {
			const raw = await executor(args);
			if (raw === undefined || raw === null) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (typeof raw === 'string') {
				return { stdout: raw, stderr: '', exitCode: 0 };
			}
			return {
				stdout: raw.stdout ?? '',
				stderr: raw.stderr ?? '',
				exitCode: raw.exitCode ?? 0,
			};
		} catch (err: unknown) {
			const e = (err ?? {}) as ErrorLike;
			return {
				stdout: typeof e.stdout === 'string' ? e.stdout : '',
				stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
				exitCode: typeof e.code === 'number' ? e.code : 1,
			};
		}
	};
}

/**
 * Build a pass-through executor that shells out via Node's `child_process`.
 * `node:child_process` is loaded with a dynamic `import()` the first time
 * the command runs — never at module-load time — so this file stays
 * Cloudflare-import-safe. If the command is invoked on a non-Node runtime,
 * the dynamic import fails and we surface a clear, actionable error.
 */
function createExecFileExecutor(name: string, userOpts: CommandOptions): CommandExecutor {
	return async (args: string[]) => {
		let execFileAsync: (
			file: string,
			args: readonly string[],
			options: Record<string, unknown>,
		) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
		let nodeProcess: NodeJS.Process;

		try {
			const cp = await import(/* @vite-ignore */ 'node:child_process' as string);
			const util = await import(/* @vite-ignore */ 'node:util' as string);
			const proc = await import(/* @vite-ignore */ 'node:process' as string);
			execFileAsync = util.promisify(cp.execFile) as typeof execFileAsync;
			nodeProcess = (proc.default ?? proc) as NodeJS.Process;
		} catch {
			throw new Error(
				`[just-bash] defineCommand("${name}") with pass-through forms (A and B) ` +
					`requires Node — the pass-through executor shells out via ` +
					`child_process.execFile. On --target cloudflare, use the ` +
					`function form instead: defineCommand("${name}", async (args) => { ... }).`,
			);
		}

		// Build the safe default env at execute time so process.env is read
		// on the host that's actually running the command.
		const safeDefaults: Record<string, string | undefined> = {};
		for (const key of DEFAULT_ENV_KEYS) {
			safeDefaults[key] = nodeProcess.env[key];
		}
		const mergedOpts: Record<string, unknown> = {
			maxBuffer: 50 * 1024 * 1024,
			...userOpts,
			env: { ...safeDefaults, ...(userOpts.env ?? {}) },
		};

		const { stdout, stderr } = await execFileAsync(name, args, mergedOpts);
		return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
	};
}

/**
 * Register a host CLI as a custom command inside the just-bash sandbox.
 *
 * Three forms:
 *
 * ```ts
 * // A. Bare pass-through. Safe-by-default env (PATH, HOME, LANG, TZ, …).
 * //    Node only — uses child_process.execFile.
 * defineCommand('git');
 *
 * // B. Pass-through with extra env injected (e.g. a scoped token).
 * //    Node only — uses child_process.execFile.
 * defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });
 *
 * // C. Custom executor — full control over how the command runs. Useful
 * //    for `fetch`-based wrappers, mock implementations, etc.
 * //    Works on both Node and Cloudflare.
 * defineCommand('issues', async (args) => {
 *   const res = await fetch(`https://api.github.com/...`);
 *   return { stdout: await res.text() };
 * });
 * ```
 *
 * If a Node-only form (A or B) is invoked on `--target cloudflare`, the
 * command will throw at execute time with an actionable message pointing
 * users at form C.
 */
export function defineCommand(name: string): CustomCommand;
export function defineCommand(name: string, options: CommandOptions): CustomCommand;
export function defineCommand(name: string, execute: CommandExecutor): CustomCommand;
export function defineCommand(
	name: string,
	arg?: CommandOptions | CommandExecutor,
): CustomCommand {
	const executor: CommandExecutor =
		typeof arg === 'function' ? arg : createExecFileExecutor(name, arg ?? {});
	const run = normalizeExecutor(executor);
	return {
		name,
		execute: async (args: string[]) => run(args),
	};
}
```

## Required dependencies

just-bash is a single package that works on both Flue build targets:

```bash
npm install just-bash
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

**just-bash has no API key.** It runs entirely in-process — there's no
remote service to authenticate against.

If `network.dangerouslyAllowFullInternetAccess` is enabled, in-sandbox
commands use the host's network stack directly, so any credentials those
commands need (e.g. `GITHUB_TOKEN` for `gh`, `OPENAI_API_KEY` for `curl`
calls) come from the agent's process environment. Use the project's
existing conventions (`AGENTS.md`, `.env`, `.dev.vars`, a secret manager,
CI vars) for storing those.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { justBash } from '../connectors/just-bash'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  const agent = await init({
    sandbox: justBash(),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('echo "hello just-bash" > /tmp/hello.txt && cat /tmp/hello.txt');
}
```

## Connecting external CLIs

just-bash runs in-process with no real `$PATH`, so binaries the agent
might want — `gh`, `npm`, `git`, `docker`, an internal CLI, anything —
aren't available unless you explicitly register them. The connector ships
a `defineCommand(...)` helper for this.

The pattern: configure the command on the host, where secrets live; the
agent sees only the command's name and its stdout/stderr/exitCode. Tokens
and other sensitive env vars never enter the sandbox.

`defineCommand` has three forms:

- **Forms A and B** (pass-through and pass-through-with-env) shell out
  via Node's `child_process.execFile`. They only work on `--target node`.
  If invoked on Cloudflare, they throw a clear runtime error pointing at
  form C.
- **Form C** (custom executor) is target-agnostic. Use it for
  Cloudflare projects, or anywhere you want to wrap a remote API as a
  "command" without spawning a process.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { defineCommand, justBash } from '../connectors/just-bash';

export const triggers = { webhook: true };

// Form A: bare pass-through. Safe-by-default env (PATH, HOME, LANG, TZ, …)
// is forwarded automatically. Nothing else from process.env leaks.
const git = defineCommand('git');

// Form B: pass-through + injected env. The agent can run `gh issue view`,
// `gh pr create`, etc. — but never sees GH_TOKEN itself.
const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });

// Form C: fully custom executor. Useful for wrapping a remote API as a
// "command" without shelling out at all.
const issues = defineCommand('issues', async (args) => {
  const res = await fetch(`https://api.github.com/repos/${args[0]}/issues`);
  return { stdout: await res.text() };
});

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({
    sandbox: justBash({ commands: [git, gh, issues] }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.prompt(
    `Find duplicates of issue #${payload.issueNumber} using gh and post a comment.`,
  );
}
```

A few notes:

- The connector itself has no top-level Node imports, so it's safe to
  drop into a Cloudflare project. Forms A and B only attempt to load
  `node:child_process` at command-execute time; on Cloudflare they
  throw a clear, actionable error.
- The agent's `bash` tool can call these commands like any other: just
  invoke the name. just-bash routes the call through your registered
  executor.
- Throws inside a custom executor are caught and surfaced as a non-zero
  exit code — no `try`/`catch` boilerplate required.
- Returning a bare string from a custom executor is treated as stdout
  with `exitCode: 0`. Returning `void` is treated as empty success.
- Commands registered here are agent-wide: every prompt, skill, and
  shell call can use them.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `just-bash`, decide whether they
   need a persistent or per-session filesystem (and which `Filesystem`
   implementation), decide whether to enable
   `dangerouslyAllowFullInternetAccess`, decide whether they need to
   register any external CLIs via `defineCommand(...)` (and which env
   vars those need), and run `flue dev` (or `flue run <agent>`) to try
   it.
