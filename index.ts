import type {
  PlatypusPlugin,
  PluginConfigContext,
  WebSearchResult,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { z } from "zod";

// A third-party Platypus Web-search backend (ADR-0014) backed by a self-hosted
// SearXNG instance. Out of tree by design: core deliberately ships no backend,
// so an Operator running vLLM/LiteLLM has no working chat search until a plugin
// like this one is installed.
//
// The manifest `name` below is the namespace core prefixes onto every
// contribution id, so the bare `web` backend registers as `searx.web` — that is
// the string stored in `provider.web_backend`. Renaming either half orphans
// every Provider pointing at it, so both are fixed for good.

const configSchema = z
  .object({
    // Base URL of the SearXNG instance, reachable from the backend container.
    // On the compose network that is the service name, not localhost.
    baseUrl: z.string().url(),
    // SearXNG's `language` filter. `all` leaves it to the engines.
    language: z.string().default("all"),
    // Comma-separated SearXNG categories. `general` is the web index.
    categories: z.string().default("general"),
  })
  .strict();

type SearxConfig = z.infer<typeof configSchema>;

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
  contributes: {
    webBackends: [
      {
        backend: "web",
        name: "SearXNG",
        // Generous for a LAN metasearch, and it covers the factory as well as
        // every executor call in the turn, additively. Ceiling is 120_000.
        timeoutMs: 15_000,
        createExecutors: (_ctx, plugin?: PluginConfigContext) => {
          // Boot-validated against `configSchema`, so the cast is safe: a
          // missing or malformed block aborts startup, it does not reach here.
          const config = plugin?.config as SearxConfig;

          return {
            web_search: async ({ query }) => {
              const url = new URL("/search", config.baseUrl);
              url.searchParams.set("q", query);
              url.searchParams.set("format", "json");
              url.searchParams.set("language", config.language);
              url.searchParams.set("categories", config.categories);

              const response = await fetch(url, {
                headers: { Accept: "application/json" },
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
        },
      },
    ],
  },
};

export default plugin;
