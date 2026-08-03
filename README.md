# @platypus-local/searx

A Platypus **Web-search backend** (ADR-0014 Extension point) backed by a
self-hosted [SearXNG](https://docs.searxng.org/) instance.

Platypus core deliberately ships no web-search backend, so a Provider pointed at
a self-hosted OpenAI-compatible endpoint (vLLM, LiteLLM, SGLang) has a chat
search toggle with nothing behind it. This plugin fills that slot.

It contributes `web_search` only. `read_url` is optional in the contract, and a
search-only backend is a first-class case.

## What it registers

|                                              |                               |
| -------------------------------------------- | ----------------------------- |
| Entry for `PLATYPUS_PLUGINS`                 | `/app/plugins/searx/index.ts` |
| Manifest name (for `PLATYPUS_PLUGIN_CONFIG`) | `searx`                       |
| Backend id (stored in `provider.webBackend`) | `searx.web`                   |
| Display name                                 | SearXNG                       |

The backend id is what gets persisted on the Provider row, so the manifest `name`
and the contribution's bare `backend` are both fixed for good — renaming either
orphans every Provider pointing at it as `(not installed)`.

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

**Nothing in the Platypus repo changes.** The plugin is a directory beside the
deployment, bind-mounted into the backend container and named in
`PLATYPUS_PLUGINS` by path.

```bash
# on the host running Platypus
git clone <this repo> /srv/platypus-plugins/searx
cd /srv/platypus-plugins/searx && npm install --omit=dev   # zod, nothing else
```

Then add a compose overlay next to the deployment's `compose.yaml`:

```yaml
services:
  backend:
    volumes:
      - /srv/platypus-plugins/searx:/app/plugins/searx:ro
    environment:
      # Compose `environment:` REPLACES the .env value rather than appending, so
      # this must be the deployment's complete gate-able plugin set.
      PLATYPUS_PLUGINS: "@platypus/web-fetch,/app/plugins/searx/index.ts"
```

Two details that decide whether this resolves:

- **Mount outside `node_modules`.** Node refuses to strip types from any file
  under a `node_modules` directory, and this plugin ships TypeScript. `/app/plugins`
  keeps it clear of that rule. (A plugin published to a registry as compiled JS is
  installed the ordinary way and named by package specifier instead.)
- **Ship your own `node_modules`.** Module resolution walks up from the plugin's
  own directory, not the backend's, so `zod` must sit in
  `/srv/platypus-plugins/searx/node_modules`.

## Configure

```
PLATYPUS_PLUGINS=@platypus/web-fetch,/app/plugins/searx/index.ts
PLATYPUS_PLUGIN_CONFIG={"searx":{"config":{"baseUrl":"http://searxng:8080"}}}
```

The plugin **list** takes whatever `import()` can resolve — a package specifier
or a path. The **config object** is always keyed by the manifest name (`searx`).

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
