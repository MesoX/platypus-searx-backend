# @platypus-local/searx

A Platypus **Web-search backend** (ADR-0014 Extension point) backed by a
self-hosted [SearXNG](https://docs.searxng.org/) instance.

Platypus core deliberately ships no web-search backend, so a Provider pointed at
a self-hosted OpenAI-compatible endpoint (vLLM, LiteLLM, SGLang) has a chat
search toggle with nothing behind it. This plugin fills that slot.

It contributes `web_search` only. `read_url` is optional in the contract, and a
search-only backend is a first-class case.

## What it registers

|                                              |                         |
| -------------------------------------------- | ----------------------- |
| Package specifier (for `PLATYPUS_PLUGINS`)   | `@platypus-local/searx` |
| Manifest name (for `PLATYPUS_PLUGIN_CONFIG`) | `searx`                 |
| Backend id (stored in `provider.webBackend`) | `searx.web`             |
| Display name                                 | SearXNG                 |

The two names are different on purpose, and mixing them up is the usual failure:
the plugin **list** takes the package specifier, the **config object** is keyed by
the manifest name.

## Requirements

A reachable SearXNG instance with JSON output enabled and the bot limiter off —
both are non-default, and without them every request from a non-browser client
returns `403`:

```yaml
# settings.yml
use_default_settings: true
server:
  secret_key: "<random>"
  limiter: false
search:
  formats:
    - html
    - json
```

## Install

The plugin has to resolve from the backend's `node_modules`, so with the Docker
image it must be part of the pnpm workspace at build time. Copy this directory to
`packages/searx-backend/` in the Platypus tree, add it to the backend's
dependencies (**`dependencies`**, not `devDependencies` — the image's `prod-deps`
stage runs `pnpm install --prod`), and refresh the lockfile:

```jsonc
// apps/backend/package.json
"dependencies": {
  "@platypus-local/searx": "workspace:*"
}
```

```bash
pnpm install   # commit the updated pnpm-lock.yaml; the image build uses --frozen-lockfile
```

## Configure

```
PLATYPUS_PLUGINS=@platypus/web-fetch,@platypus-local/searx
PLATYPUS_PLUGIN_CONFIG={"searx":{"config":{"baseUrl":"http://searxng:8080"}}}
```

| Key          | Required | Default   | Meaning                                                                                                                                  |
| ------------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`    | yes      | —         | Base URL of the SearXNG instance as the **backend container** sees it. On a compose network that is the service name, never `localhost`. |
| `language`   | no       | `all`     | SearXNG's language filter.                                                                                                               |
| `categories` | no       | `general` | Comma-separated SearXNG categories.                                                                                                      |

Config is validated at boot and fails loud: malformed JSON, an unknown key or a
non-URL `baseUrl` aborts startup with a plugin-named error. There are no secrets
here — if a backend ever needs an API key it belongs in `credentials`, never in
`config`.

Then select **SearXNG** under Provider → Advanced settings → Web-search backend.
Native web search must stay **on**; until the two controls are collapsed into one,
switching it off disables the selected backend too.

## What core owns

The backend supplies execution only. Core owns the tool schema and description,
caps results to 10, truncates titles to 200 and snippets to 500 characters, drops
any result whose URL is not `http(s)`, applies the timeout to both the factory and
each call, and turns a thrown error into the model-facing error string. This
plugin therefore returns every hit SearXNG gave it, untruncated, and throws on
failure rather than returning an error shape.
