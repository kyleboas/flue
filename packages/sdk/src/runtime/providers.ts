/**
 * Runtime provider registry consumed by `resolveModel`.
 *
 * Two layers compose here, intentionally distinct because they answer
 * different questions:
 *
 *   1. **pi-ai's `apiProviderRegistry`** (api string → wire-protocol handler).
 *      Owned by `@mariozechner/pi-ai` itself. We re-export pi-ai's
 *      `registerApiProvider` from here so users that need to register a
 *      brand-new wire protocol have a one-stop import surface.
 *
 *   2. **Flue's `userModels` map** (URL-prefix string → partial pi-ai Model
 *      template). Owned here. When agent code calls `init({ model:
 *      'foo/bar' })`, `resolveModel` looks up `'foo'` in this map to get the
 *      partial Model template (`baseUrl`, `apiKey`, `binding`, …) and fills
 *      in the model id. This is the layer that lets users define a named
 *      provider once and reference it by URL prefix everywhere.
 *
 * Both layers are module-scoped on purpose. Module scope is per-isolate on
 * Cloudflare (each Durable Object isolate, plus the worker entry isolate,
 * gets its own copy populated identically by the same `app.ts` import). On
 * Node it's per-process. Last-write-wins matches pi-ai's own registry
 * semantics; calling `registerProvider` twice with the same name overwrites.
 *
 * The Flue-side registry exists, rather than folding everything into
 * pi-ai's, because pi-ai expects callers to construct a fully-formed
 * `Model<Api>` themselves — it has no concept of "URL prefix → partial
 * Model template." That mapping is the thing Flue adds. Trying to express
 * it inside pi-ai's registry would smear two different concerns together.
 */

import {
	registerApiProvider as piRegisterApiProvider,
	type Api,
	type Model,
} from '@mariozechner/pi-ai';
import {
	CLOUDFLARE_AI_BINDING_API,
	CLOUDFLARE_AI_BINDING_PROVIDER,
} from '../cloudflare-model.ts';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Cloudflare Workers AI binding shape. Typed structurally rather than via
 * `@cloudflare/workers-types` so this module stays import-safe on the Node
 * target (where workers-types is irrelevant). The user passes whatever
 * `env.AI` resolves to; `runtime/providers.ts` only needs the `run` method
 * surface that the workers-ai stream function consumes.
 */
export interface CloudflareAIBinding {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<Response | Record<string, unknown>>;
}

/**
 * Discriminated union on `api`. Two cases today:
 *
 *   - HTTP wire formats (`'openai-completions'`, `'anthropic-messages'`,
 *     anything else pi-ai ships): `baseUrl` is required; `apiKey` and
 *     `headers` are optional auth surfaces.
 *
 *   - `'cloudflare-ai-binding'`: dispatches via `env.AI.run()` rather than
 *     HTTP, so `baseUrl` is meaningless. Instead we capture the actual
 *     binding object on `binding`.
 *
 * `api` is typed as `Api` (pi-ai's `KnownApi | (string & {})`) so unknown
 * APIs registered via `registerApiProvider` still type-check.
 *
 * On TS narrowing: `Api = KnownApi | (string & {})` defeats the obvious
 * `Exclude<Api, 'cloudflare-ai-binding'>` discriminator (the open-string
 * brand swallows the literal). Both variants therefore type `api` as `Api`
 * and use the {@link isCloudflareBindingRegistration} type predicate to
 * narrow at use sites. User-facing inference still works as expected:
 * passing `{ api: 'openai-completions', baseUrl: '...' }` requires
 * `baseUrl`, and passing `{ api: 'cloudflare-ai-binding', binding: ... }`
 * requires `binding` — TS resolves the union by structural compatibility.
 */
export type ProviderRegistration =
	| HttpProviderRegistration
	| CloudflareAIBindingRegistration;

export interface HttpProviderRegistration {
	api: Api;
	/** Endpoint root, e.g. `'https://api.anthropic.com/v1'`. */
	baseUrl: string;
	/**
	 * Optional API key. Propagated to pi-ai via the harness's per-call
	 * `getApiKey(provider)` callback. Falls back to whatever pi-ai's normal
	 * env-var lookup produces if unset.
	 */
	apiKey?: string;
	/** Optional default headers merged into every outgoing request. */
	headers?: Record<string, string>;
	/**
	 * Override the pi-ai `provider` slug surfaced on AssistantMessage records
	 * and used as the key for `init({ providers: { ... } })` overrides.
	 * Defaults to the registry name (the key passed to `registerProvider`).
	 */
	provider?: string;
}

export interface CloudflareAIBindingRegistration {
	api: typeof CLOUDFLARE_AI_BINDING_API;
	/** The captured `env.AI` reference. Read at registration time. */
	binding: CloudflareAIBinding;
	/**
	 * Override the pi-ai `provider` slug. Defaults to `'workers-ai'`,
	 * matching pi-ai's catalog convention for Cloudflare-Workers-AI models.
	 */
	provider?: string;
}

/**
 * Type predicate that narrows {@link ProviderRegistration} to the
 * Cloudflare AI binding case. Used internally because pi-ai's `Api` type
 * (`KnownApi | (string & {})`) prevents direct `def.api === '...'`
 * comparison from narrowing the discriminated union.
 */
function isCloudflareBindingRegistration(
	def: ProviderRegistration,
): def is CloudflareAIBindingRegistration {
	return def.api === CLOUDFLARE_AI_BINDING_API;
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Module-scoped registry. Populated once per isolate at module init time
 * (the generated server entry's internal registrations + the user's
 * `app.ts` top-level calls). Read at request time by
 * {@link resolveRegisteredModel}, which `internal.ts:resolveModel` calls
 * before falling back to pi-ai's static catalog.
 */
const userModels = new Map<string, ProviderRegistration>();

/**
 * Register a Flue-level model provider keyed by URL prefix.
 *
 * The same call shape works on Node and Cloudflare. On Cloudflare, top-level
 * access to `env` from `cloudflare:workers` is required to capture binding
 * references like `env.AI`; reading `env.SOMETHING_VAR` for plain string
 * env vars works at module top level too (Workers populates them lazily on
 * first access).
 *
 * Last-write-wins. Calling `registerProvider('foo', ...)` twice with the
 * same name simply overwrites — matches pi-ai's `registerApiProvider`
 * semantics. Note that on Cloudflare, the generated `_entry.ts` registers
 * its internal `'cloudflare'` provider AFTER the user's `app.ts` is
 * imported (ESM hoisting), so user attempts to rebind that specific name
 * are overridden by the build's own registration. If you need a different
 * Cloudflare-side integration, register it under a non-`cloudflare`
 * prefix.
 */
export function registerProvider(
	name: string,
	registration: ProviderRegistration,
): void {
	userModels.set(name, registration);
}

/**
 * Read accessor. Returns the live `Map`; not a snapshot. Internal-only —
 * exposed for `internal.ts:resolveModel` to consult when resolving model
 * strings. NOT exported from `@flue/sdk/app`; users should treat the
 * registry as write-only via {@link registerProvider}.
 */
export function getRegisteredProviders(): ReadonlyMap<string, ProviderRegistration> {
	return userModels;
}

/**
 * Look up an apiKey by pi-ai provider slug. Walks the registry and matches
 * each entry's effective `provider` field — which is either the override on
 * the registration or the registry name (`workers-ai` for binding entries
 * regardless of name, matching {@link buildModelFromRegistration}'s output).
 *
 * Used by the session harness's `getApiKey(provider)` callback as the
 * fallback after consulting the explicit `init({ providers: { ... } })`
 * config. Returns undefined when no registered provider matches or matched
 * entries have no apiKey set.
 */
export function getRegisteredApiKey(provider: string): string | undefined {
	for (const [name, def] of userModels) {
		const effective = effectiveProviderSlug(name, def);
		if (effective !== provider) continue;
		// Only HTTP registrations carry apiKey; binding entries don't have
		// the field. The narrowing below also satisfies the TS type
		// system, which can't read `'apiKey' in def` as a discriminator.
		if (!isCloudflareBindingRegistration(def)) return def.apiKey;
	}
	return undefined;
}

/**
 * Re-export of pi-ai's `registerApiProvider`. Use to register a brand-new
 * wire-protocol handler for an `api` slug pi-ai doesn't ship. Then call
 * {@link registerProvider} to alias a URL prefix to that api.
 *
 * ```ts
 * registerApiProvider({ api: 'my-novel-api', stream, streamSimple });
 * registerProvider('thing', { api: 'my-novel-api', baseUrl: '...', apiKey: '...' });
 * ```
 *
 * pi-ai's registry is also module-scoped and last-write-wins. Calling
 * `registerApiProvider` repeatedly with the same `api` string overwrites,
 * so generated code can register on every isolate boot without dedupe
 * bookkeeping.
 */
export const registerApiProvider = piRegisterApiProvider;

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolve `'name/modelId'` against the runtime registry. Returns a fully
 * constructed pi-ai `Model<Api>` literal, or `undefined` if nothing
 * matches `name`. The constructed Model carries a non-pi-ai `binding`
 * field for `cloudflare-ai-binding` registrations so the workers-ai stream
 * function can read it without going through AsyncLocalStorage.
 */
export function resolveRegisteredModel(
	name: string,
	modelId: string,
): Model<Api> | undefined {
	const def = userModels.get(name);
	if (!def) return undefined;
	return buildModelFromRegistration(name, def, modelId);
}

/**
 * Construct a pi-ai `Model<Api>` literal from a registration.
 *
 * Cost / context-window / maxTokens are zeroed because no static catalog
 * exists for user-defined providers. Flue features that read those (cost
 * display, overflow detection) degrade gracefully when zero.
 *
 * `apiKey` is intentionally NOT placed on the Model literal — pi-ai's
 * `Model<Api>` type doesn't carry an `apiKey` field. It flows through the
 * harness's `getApiKey(provider)` callback instead; see
 * {@link getRegisteredApiKey}.
 *
 * The `binding` field on the cloudflare-ai-binding case IS placed on the
 * Model literal as a non-pi-ai extension. The workers-ai stream function
 * reads it back via a structural cast at request time.
 */
function buildModelFromRegistration(
	name: string,
	def: ProviderRegistration,
	modelId: string,
): Model<Api> {
	if (isCloudflareBindingRegistration(def)) {
		return {
			id: modelId,
			name: modelId,
			api: CLOUDFLARE_AI_BINDING_API,
			provider: def.provider ?? CLOUDFLARE_AI_BINDING_PROVIDER,
			baseUrl: '',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
			// Non-pi-ai extension. Read by `cloudflare/workers-ai-provider.ts`
			// off the resolved Model literal so the request-time path doesn't
			// have to consult AsyncLocalStorage.
			binding: def.binding,
		} as Model<Api> & { binding: CloudflareAIBinding };
	}

	return {
		id: modelId,
		name: modelId,
		api: def.api,
		provider: def.provider ?? name,
		baseUrl: def.baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		headers: def.headers,
	};
}

/**
 * Compute the effective pi-ai provider slug for a registration. Mirrors
 * the logic inside {@link buildModelFromRegistration} — kept in sync by
 * being expressed as a single helper used by both the model builder and
 * {@link getRegisteredApiKey}'s reverse lookup.
 */
function effectiveProviderSlug(name: string, def: ProviderRegistration): string {
	if (isCloudflareBindingRegistration(def)) {
		return def.provider ?? CLOUDFLARE_AI_BINDING_PROVIDER;
	}
	return def.provider ?? name;
}


