export { getVirtualSandbox } from './virtual-sandbox.ts';
export { defineCommand } from './define-command.ts';
export type { VirtualSandboxOptions } from './virtual-sandbox.ts';

export { cfSandboxToSessionEnv } from './cf-sandbox.ts';

export { store } from './session-store.ts';

export { runWithCloudflareContext, getCloudflareContext } from './context.ts';
export type { CloudflareContext } from './context.ts';

// Returns the pi-ai ApiProvider definition for the Cloudflare AI binding.
// The generated `_entry.ts` calls `registerApiProvider(getCloudflareAIBindingApiProvider())`
// at module top level. Caller is responsible for the actual registration —
// keeping the helper a value-returning function (rather than a side-effecting
// register call) means the registration site is visible at the call site
// instead of buried in this module.
export { getCloudflareAIBindingApiProvider } from './workers-ai-provider.ts';
