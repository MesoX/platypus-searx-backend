// The slice of `@platypuschat/plugin-sdk` this plugin builds against.
//
// The SDK is a **type-only** dependency: every symbol below is erased at
// runtime, so the plugin's sole runtime dependency is zod. That keeps it
// installable as a plain directory dropped next to a Platypus deployment —
// no workspace membership, no lockfile entry, nothing added to the Platypus
// repo. Once `@platypuschat/plugin-sdk` is on a registry the deployment can
// reach, delete this file and import the same names from the package; the
// shapes are copied verbatim from SDK 0.2.0.
//
// Copied verbatim from packages/plugin-sdk/index.ts @ 0.2.0 in
// https://github.com/willdady/platypus, used under its MIT license —
// Copyright (c) 2026 Will Dady. The full notice is reproduced in LICENSE.

export interface PluginConfigContext<
  TConfig = unknown,
  TCredentials = unknown,
> {
  config: TConfig;
  credentials: TCredentials;
}

export interface WebBackendContext {
  orgId: string;
  workspaceId: string;
  userId: string;
}

/** One search hit. Core caps the count and truncates the strings (ADR-0014). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResults {
  query: string;
  results: WebSearchResult[];
  answer?: string;
}

export interface ReadUrlResult {
  content: string;
  url: string;
  contentType?: string;
}

export interface WebBackendExecutors {
  web_search: (input: {
    query: string;
  }) => Promise<WebSearchResults> | WebSearchResults;
  read_url?: (input: { url: string }) => Promise<ReadUrlResult> | ReadUrlResult;
}

export interface WebBackendContribution {
  /** Bare discriminator; core namespaces it to `${manifest.name}.${backend}`. */
  backend: string;
  /** Display label for the catalog and the Provider selector. */
  name: string;
  /** Per-call timeout; core defaults to 30_000 and refuses above 120_000. */
  timeoutMs?: number;
  createExecutors(
    ctx: WebBackendContext,
    plugin?: PluginConfigContext,
  ): WebBackendExecutors | Promise<WebBackendExecutors>;
}

export interface PluginContributions {
  webBackends?: WebBackendContribution[];
}

export interface PlatypusPlugin {
  name: string;
  version: string;
  apiVersion: number;
  configSchema?: unknown;
  credentialsSchema?: unknown;
  contributes: PluginContributions;
}
