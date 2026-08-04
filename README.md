# @platypus-local/searx

A Platypus **Web-search backend** (ADR-0014 Extension point): search through a
self-hosted [SearXNG](https://docs.searxng.org/) instance, page reading through a
headless browser over CDP.

Platypus core deliberately ships no web-search backend, so a Provider pointed at
a self-hosted OpenAI-compatible endpoint (vLLM, LiteLLM, SGLang) has a chat
search toggle with nothing behind it. This plugin fills that slot.

`web_search` is always contributed. `read_url` appears only when `browserUrl` is
configured — it is optional in the contract, and a search-only deployment is a
first-class case rather than a degraded one.

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

**SearXNG**, with JSON output enabled and the bot limiter off. Both are
non-default, and without them every request from a non-browser client returns
`403`:

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

**A headless browser speaking CDP**, if you want `read_url`. Developed against
[obscura](https://github.com/h4ckf0r0day/obscura), whose default container command
is already `serve --port 9222 --host 0.0.0.0`; anything Chrome-protocol-compatible
should work, since the client uses only `Target.createTarget`,
`Target.attachToTarget`, `Page.enable`, `Page.navigate`, `Page.loadEventFired` and
`Runtime.evaluate`.

> **A CDP endpoint is arbitrary code execution in a browser.** Keep it on the
> internal network and off the host's public interfaces — bind the host port to
> loopback, or publish no host port at all. Note also that the plugin runs
> in-process with the backend (ADR-0013), with its env and DB credentials: treat a
> web backend like a dependency, not a sandbox.

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
PLATYPUS_PLUGIN_CONFIG={"searx":{"config":{"baseUrl":"http://searxng:8080","browserUrl":"http://obscura:9222"}}}
```

The plugin **list** takes whatever `import()` can resolve — a package specifier
or a path. The **config object** is always keyed by the manifest name (`searx`).

| Key                | Required | Default   | Meaning                                                                                                                                        |
| ------------------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | yes      | —         | Base URL of the SearXNG instance as the **backend container** sees it. On a compose network that is the service name, never `localhost`.       |
| `browserUrl`       | no       | —         | CDP HTTP endpoint of a headless browser. Omit to contribute search only; no `read_url` tool is built and core substitutes nothing for it.      |
| `readMode`         | no       | `text`    | `text` or `markdown`. Markdown keeps headings and link targets but measured ~3x larger on a news index page; text wins on prose per character. |
| `pruneBoilerplate` | no       | `true`    | Strip non-content nodes and prefer an `<article>`/`<main>` before extracting.                                                                  |
| `language`         | no       | `all`     | SearXNG's language filter.                                                                                                                     |
| `categories`       | no       | `general` | Comma-separated SearXNG categories.                                                                                                            |

Config is validated at boot and fails loud: malformed JSON, an unknown key or a
non-URL `baseUrl` aborts startup with a plugin-named error. There are no secrets
here — if a backend ever needs an API key it belongs in `credentials`, never in
`config`.

`browserUrl` is deliberately Operator config and never anything the model can
influence. Core's egress guard covers the **model-supplied** URL handed to
`read_url`; it does not cover this plugin's own call to the browser. Loopback is
always blocked for the model, so a prompt-injected model asking to read
`http://localhost:4000` is refused, while the plugin reaching the browser over the
compose network is unaffected.

Then select **SearXNG** under Provider → Advanced settings → Web-search backend.
Native web search must stay **on**; until the two controls are collapsed into one,
switching it off disables the selected backend too.

## What core owns

The backend supplies execution only. Core owns the tool schemas and descriptions,
caps search results to 10, truncates titles to 200 and snippets to 500 characters,
drops any result whose URL is not `http(s)`, caps `read_url` content at 1 000 000
characters and does the `max_length` / `start_index` slicing with its continuation
hint, runs the egress guard, applies `timeoutMs` to both the factory and each call,
and turns a thrown error into the model-facing error string.

So this plugin returns every hit SearXNG gave it and the page's full text, both
untruncated, and throws on failure rather than returning an error shape.

### What the plugin owns: what counts as the page

Extraction is the backend's job, not core's, and the choice is load-bearing —
core's default page is 5000 characters, so whatever comes out first is most of
what the model ever sees. Measured on the same four news URLs:

| Page                  | `innerText`, unpruned | `text` + prune |
| --------------------- | --------------------: | -------------: |
| edition.cnn.com       |             2,008,031 |         48,962 |
| apnews.com            |               416,189 |        167,944 |
| theguardian.com/world |                18,157 |          6,569 |
| an NPR article        |                16,290 |          7,379 |

Two distinct causes, both handled in `cdp.ts`:

1. **Non-content nodes arriving as text.** `document.body.innerText` is supposed
   to honour `display: none` on `script` / `style` / `noscript`; obscura's does
   not, so pages came back beginning with Google Tag Manager `<noscript><iframe>`
   markup and inline analytics source. CNN's 2 MB was mostly that. The nodes are
   removed before extraction, which fixes it for either `readMode` — obscura's
   own markdown converter already skips them, but relying on that would leave
   `text` broken.
2. **Boilerplate ahead of the article.** An `<article>` / `<main>` carrying more
   than 500 characters replaces the body; failing that, `nav` / `header` /
   `footer` / `aside` are dropped. The 500-character floor guards against a site
   that ships an empty landmark and puts its content elsewhere.

`markdown` mode uses obscura's **`LP.getMarkdown`**, a non-standard CDP domain, and
falls back to text extraction on `-32601` — which is what keeps `browserUrl`
pointable at plain headless Chrome. It takes no parameters, so the pruning above
is the only way to scope what it converts.

Not solved: a homepage is genuinely mostly links (AP stays at 167 k), and
real main-content extraction — obscura's `extract_readable_text` — is CLI/MCP-only
with no CDP surface.

`timeoutMs` is 60 000 here — sized for a cold render, not for the metasearch, since
the budget spans the factory and every call in the turn additively. The ceiling
core enforces is 120 000, and exceeding it fails boot by name rather than clamping.
