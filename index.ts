import { z } from "zod";
import { renderPage } from "./cdp.ts";
import type {
  PlatypusPlugin,
  PluginConfigContext,
  WebBackendExecutors,
  WebSearchResult,
} from "./types.ts";

// The minimum API major this manifest needs (ADR-0013: apiVersion is majors-only,
// and core accepts N and N-1). 2, not 3: v3 only re-signs Sandbox backends, so a
// Web-search backend gains nothing from it, and 2 keeps the plugin loadable on a
// v2 core too. A v1 core (before upstream db2d342b) refuses it at boot. Inlined
// rather than imported from @platypuschat/plugin-sdk so the plugin's only
// runtime dependency is zod — see types.ts for why the SDK is a type-only
// dependency here.
const PLUGIN_API_VERSION = 2;

// A third-party Platypus Web-search backend (ADR-0014) backed by a self-hosted
// SearXNG instance, optionally paired with a headless browser (obscura) for page
// reading. Out of tree by design: core deliberately ships no backend, so an
// Operator running vLLM/LiteLLM has no working chat search until a plugin like
// this one is installed.
//
// The manifest `name` below is the namespace core prefixes onto every
// contribution id, so the bare `web` backend registers as `searx.web` — that is
// the string stored in `provider.search_source`. Renaming either half orphans
// every Provider pointing at it, so both are fixed for good. The display name
// carries no such weight and is free to change.

const configSchema = z
  .object({
    // Base URL of the SearXNG instance, reachable from the backend container.
    // On the compose network that is the service name, not localhost.
    baseUrl: z.string().url(),
    // SearXNG's `language` filter. `all` leaves it to the engines.
    language: z.string().default("all"),
    // Comma-separated SearXNG categories. `general` is the web index.
    categories: z.string().default("general"),
    // CDP endpoint of a headless browser. Omit it and the backend contributes
    // search only — `read_url` is optional in the contract and a search-only
    // backend is a first-class case, so an Operator running no browser gets a
    // working search rather than a broken reader.
    browserUrl: z.string().url().optional(),
    // What a page is turned into.
    //
    // `markdown` by default because it is the only mode that carries link
    // targets: flat text renders an anchor as its label, so a model reading a
    // page cannot follow anything on it and has to search again for every hop —
    // and search snippets measure 120-160 characters, enough to choose a link
    // and never enough to answer. Links are rewritten absolute before
    // conversion (see cdp.ts), so they are usable as `read_url` input.
    //
    // It costs 1.5x-6x more characters than `text` for the same page. That is a
    // budget the model can page through; a URL it never saw it cannot invent.
    // `text` stays for deployments that would rather spend the context.
    readMode: z.enum(["markdown", "text"]).default("markdown"),
    // Strip non-content nodes and prefer an `<article>`/`<main>` before
    // extracting. On by default: core's default page is 5000 characters, and on
    // a news homepage that budget is otherwise spent entirely on nav.
    pruneBoilerplate: z.boolean().default(true),
  })
  .strict();

type SearxConfig = z.infer<typeof configSchema>;

// Secrets live here, never in `configSchema`: core validates this block on its
// own and keeps it out of `config`.
const credentialsSchema = z
  .object({
    // Bearer token for the browser's CDP endpoint. obscura >= 0.2.3 refuses to
    // listen beyond loopback without OBSCURA_CDP_TOKEN (>= 32 bytes) and then
    // demands it on `/json/version` and the WebSocket upgrade alike. Set it to
    // the same value; leave it out for a browser that takes no token.
    browserToken: z.string().min(32).optional(),
  })
  .strict();

type SearxCredentials = z.infer<typeof credentialsSchema>;

// The subset of SearXNG's JSON response this backend reads. Parsed defensively:
// it is a separate service that can be upgraded independently of this plugin.
interface SearxResponse {
  results?: unknown;
  answers?: unknown;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// SearXNG's `answers` is a list of strings on older releases and a list of
// `{ answer, url, ... }` objects on newer ones. Take whichever is there.
const firstAnswer = (answers: unknown): string | undefined => {
  if (!Array.isArray(answers)) return undefined;
  for (const entry of answers) {
    const direct = asString(entry);
    if (direct) return direct;
    if (entry && typeof entry === "object") {
      const nested = asString((entry as { answer?: unknown }).answer);
      if (nested) return nested;
    }
  }
  return undefined;
};

export const plugin: PlatypusPlugin = {
  name: "searx",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema,
  credentialsSchema,
  contributes: {
    webBackends: [
      {
        backend: "web",
        name: "SearXNG",
        // A LAN metasearch needs a couple of seconds; a cold headless render of
        // a heavy page needs far more. The budget covers the factory AND every
        // executor call in the turn, additively, so it is sized for the reader
        // rather than the searcher. Ceiling is 120_000.
        timeoutMs: 60_000,
        // Typed as `SearxConfig` rather than cast: core boot-validates the
        // block against `configSchema`, so a missing or malformed one aborts
        // startup and never reaches here.
        createExecutors: (
          _ctx,
          plugin: PluginConfigContext<SearxConfig, SearxCredentials>,
        ) => {
          const config = plugin.config;
          const browserToken = plugin.credentials.browserToken;

          const executors: WebBackendExecutors = {
            web_search: async ({ query }, { signal }) => {
              const url = new URL("/search", config.baseUrl);
              url.searchParams.set("q", query);
              url.searchParams.set("format", "json");
              url.searchParams.set("language", config.language);
              url.searchParams.set("categories", config.categories);

              // `signal` fires on cancel or when `timeoutMs` passes, so the
              // request stops when core stops waiting for it.
              const response = await fetch(url, {
                headers: { Accept: "application/json" },
                signal,
              });
              // Throw rather than returning an error shape: core catches it,
              // turns it into the model-facing error string and logs the cause.
              if (!response.ok) {
                throw new Error(
                  `SearXNG responded ${response.status} ${response.statusText}`,
                );
              }

              const body = (await response.json()) as SearxResponse;
              const raw = Array.isArray(body.results) ? body.results : [];

              // Return everything SearXNG gave us. Core caps the count, drops
              // non-http(s) URLs and truncates every string — a backend that
              // pre-truncates only loses information.
              const results: WebSearchResult[] = [];
              for (const entry of raw) {
                if (!entry || typeof entry !== "object") continue;
                const hit = entry as Record<string, unknown>;
                const hitUrl = asString(hit.url);
                if (!hitUrl) continue;
                results.push({
                  title: asString(hit.title) ?? hitUrl,
                  url: hitUrl,
                  snippet: asString(hit.content),
                });
              }

              return {
                query,
                results,
                answer: firstAnswer(body.answers),
              };
            },
          };

          // Contributed only when a browser is configured. Core does not
          // substitute anything for a missing `read_url` — by design, so
          // leaving @platypus/web-fetch out of PLATYPUS_PLUGINS stays a real
          // decision rather than one this plugin quietly reverses.
          if (config.browserUrl) {
            const browserUrl = config.browserUrl;
            executors.read_url = async ({ url }, { signal }) => {
              // The URL is model-supplied and core has already run its egress
              // guard on it. That guard does NOT cover this plugin's own call
              // to the browser, which is why `browserUrl` is Operator config
              // and never anything the model can influence.
              const page = await renderPage(
                browserUrl,
                url,
                45_000,
                config.readMode,
                config.pruneBoilerplate,
                signal,
                browserToken,
              );
              if (!page.content) {
                throw new Error(
                  `The browser rendered no readable text at ${page.url}`,
                );
              }
              return page;
            };
          }

          return executors;
        },
      },
    ],
  },
};

export default plugin;
