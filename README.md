# @platypus-local/searx

A Platypus **Web-search backend** (ADR-0014 Extension point), backed by two
self-hosted services:

|             | Service                                                                                                           | Fills        |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| **Search**  | [SearXNG](https://docs.searxng.org/) — a self-hosted metasearch engine                                            | `web_search` |
| **Reading** | [obscura](https://github.com/h4ckf0r0day/obscura) — a Rust headless browser exposing the Chrome DevTools Protocol | `read_url`   |

Platypus core deliberately ships no web-search backend, so a Provider pointed at
a self-hosted OpenAI-compatible endpoint (vLLM, LiteLLM, SGLang) has a chat
search toggle with nothing behind it. This plugin fills that slot with services
you run yourself — no search API key, no third-party account, nothing leaving
your network except the searches and page fetches themselves.

`web_search` is always contributed. `read_url` appears only when `browserUrl` is
configured — it is optional in the contract, and a search-only deployment is a
first-class case rather than a degraded one. obscura is what the reader was
developed and measured against, but the client uses only standard CDP plus one
optional obscura extension, so any Chrome-protocol browser works (see
[What counts as the page](#what-the-plugin-owns-what-counts-as-the-page)).

## What it registers

|                                                |                                |
| ---------------------------------------------- | ------------------------------ |
| Entry for `PLATYPUS_PLUGINS`                   | `/app/plugins/searx/index.ts`  |
| Manifest name (names the config variable)      | `searx`                        |
| Config variable                                | `PLATYPUS_PLUGIN_CONFIG_SEARX` |
| Plugin API                                     | v2 (core accepting v2 or v3)   |
| Backend id (stored in `provider.searchSource`) | `searx.web`                    |
| Display name                                   | SearXNG                        |

The backend id is what gets persisted on the Provider row, so the manifest `name`
and the contribution's bare `backend` are both fixed for good — renaming either
orphans every Provider pointing at it as `(not installed)`.

## Requirements

Both services need to be reachable from the **backend container** — on a compose
network that means by service name, never `localhost`.

### SearXNG

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    environment:
      SEARXNG_BASE_URL: http://searxng:8080/
    volumes:
      - ./searxng:/etc/searxng
    networks: [platypus-network]
    restart: unless-stopped
```

Two settings are **non-default and both required** — without them every request
from a non-browser client returns `403`:

```yaml
# ./searxng/settings.yml
use_default_settings: true
server:
  secret_key: "<random>"
  limiter: false # bot detection blocks non-browser clients
search:
  formats:
    - html
    - json # off by default; this plugin needs it
```

### obscura (only if you want `read_url`)

[obscura](https://github.com/h4ckf0r0day/obscura) is a Rust headless browser that
runs real JavaScript via V8 and speaks the Chrome DevTools Protocol.

Since **0.2.3** it refuses to listen beyond loopback without
`OBSCURA_CDP_TOKEN` (at least 32 bytes) — and a container must listen on
`0.0.0.0` for the backend to reach it — so give it a token and hand the plugin
the same value as `credentials.browserToken` ([Configure](#configure)). The
plugin sends it as `Authorization: Bearer` on `/json/version` and on the
WebSocket upgrade, which is where obscura checks it.

```yaml
services:
  obscura:
    image: h4ckf0r0day/obscura:latest
    command: ["serve", "--port", "9222", "--host", "0.0.0.0"]
    environment:
      OBSCURA_CDP_TOKEN: ${OBSCURA_CDP_TOKEN} # openssl rand -hex 32, in .env
    networks: [platypus-network]
    # Loopback only — see the warning below. Omit entirely if you never need to
    # poke at it by hand.
    ports:
      - "127.0.0.1:9222:9222"
    restart: unless-stopped
```

Verify it from inside the network, which is how the plugin sees it:

```bash
docker compose exec -e T="$OBSCURA_CDP_TOKEN" backend node -e \
  "fetch('http://obscura:9222/json/version',{headers:{Authorization:'Bearer '+process.env.T}}).then(r=>r.json()).then(v=>console.log(v.Browser))"
# → Chrome/145.0.0.0   (401 without the header)
```

**Any Chrome-protocol browser works.** The client uses only `Target.createTarget`,
`Target.attachToTarget`, `Page.enable`, `Page.navigate`, `Page.loadEventFired` and
`Runtime.evaluate`, plus obscura's own `LP.getMarkdown` where available — and that
one degrades to text extraction on `-32601 Unknown domain` rather than failing.
Note that obscura exposes **no REST reader**: `serve` answers only `/json/version`,
`/json/list` and `/json/protocol`, so CDP is the whole interface.

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
PLATYPUS_PLUGIN_CONFIG_SEARX={"config":{"baseUrl":"http://searxng:8080","browserUrl":"http://obscura:9222"},"credentials":{"browserToken":"<OBSCURA_CDP_TOKEN>"}}
```

The plugin **list** takes whatever `import()` can resolve — a package specifier
or a path. The **config variable** is named after the manifest name (`searx` →
`PLATYPUS_PLUGIN_CONFIG_SEARX`), never the path. The older combined
`PLATYPUS_PLUGIN_CONFIG={"searx":{"config":{…}}}` still works on current core
but is deprecated.

**Core compatibility.** The manifest declares plugin API **v2**, so it loads on a
core whose window covers v2 (today `[2, 3]`). A core from before upstream
`db2d342b` accepts only v1 and refuses it at boot — run tag `v1-api-last` there.

| Key                | Required | Default    | Meaning                                                                                                                                                                 |
| ------------------ | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | yes      | —          | Base URL of the SearXNG instance as the **backend container** sees it. On a compose network that is the service name, never `localhost`.                                |
| `browserUrl`       | no       | —          | CDP HTTP endpoint of a headless browser. Omit to contribute search only; no `read_url` tool is built and core substitutes nothing for it.                               |
| `readMode`         | no       | `markdown` | `markdown` or `text`. Markdown is the only mode that carries link targets, so the model can follow a page instead of searching again; it costs 1.5x-6x more characters. |
| `pruneBoilerplate` | no       | `true`     | Strip non-content nodes and prefer an `<article>`/`<main>` before extracting.                                                                                           |
| `language`         | no       | `all`      | SearXNG's language filter.                                                                                                                                              |
| `categories`       | no       | `general`  | Comma-separated SearXNG categories.                                                                                                                                     |

`credentials` holds the one secret:

| Key            | Required | Meaning                                                                                                                       |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `browserToken` | no       | Bearer token for `browserUrl` — the browser's `OBSCURA_CDP_TOKEN`, at least 32 characters. Omit for a browser that takes none. |

Both blocks are validated at boot and fail loud: malformed JSON, an unknown key,
a non-URL `baseUrl` or a token under 32 characters aborts startup with a
plugin-named error. Secrets go in `credentials`, never in `config`.

`browserUrl` is deliberately Operator config and never anything the model can
influence. Core's egress guard covers the **model-supplied** URL handed to
`read_url`; it does not cover this plugin's own call to the browser. Loopback is
always blocked for the model, so a prompt-injected model asking to read
`http://localhost:4000` is refused, while the plugin reaching the browser over the
compose network is unaffected.

Then select **SearXNG (searx)** under Provider → Advanced settings → Web search.
It is one select — None, the provider's built-in search, or an installed backend —
so choosing SearXNG replaces the provider's own search for that Provider.

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
is the only way to scope what it converts. Links and image sources are resolved
against the document **before** conversion: the converter emits the raw `href`
attribute, which is relative on most sites, and core's `read_url` input is
`z.string().url()` — so an unresolved link is one the model can see and cannot
follow. Images become their alt text in `markdown` and are dropped in `text`; a
model reading text cannot open a PNG, and a README's badge URLs are ~100
characters each.

That resolution is what decides the default:

| Page                           | `markdown` | links | `text` | links |
| ------------------------------ | ---------: | ----: | -----: | ----: |
| a GitHub repository page       |      6,333 |    20 |  5,223 | **0** |
| theguardian.com/world          |     15,002 |    40 |  6,390 | **0** |
| edition.cnn.com                |     48,965 |   164 |  9,360 | **0** |
| en.wikipedia.org/wiki/Platypus |    158,041 | 1,567 | 63,549 | **0** |

Flat text renders an anchor as its label, so a model reading a page in `text`
mode has to search again for every hop — and search snippets measure 120-160
characters, enough to choose a link and never enough to answer. The extra
characters are a budget the model can page through with `start_index`; a URL it
never saw it cannot invent.

Not solved: a homepage is genuinely mostly links (AP stays at 167 k), and
real main-content extraction — obscura's `extract_readable_text` — is CLI/MCP-only
with no CDP surface.

`timeoutMs` is 60 000 here — sized for a cold render, not for the metasearch, since
the budget spans the factory and every call in the turn additively. The ceiling
core enforces is 120 000, and exceeding it fails boot by name rather than clamping.

## License and credits

MIT — see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

`types.ts` reproduces the contract types verbatim from
[`@platypuschat/plugin-sdk`](https://github.com/willdady/platypus/tree/main/packages/plugin-sdk)
2.2.0, MIT, Copyright (c) 2026 Will Dady, so that the plugin needs no dependency
on a package that is not yet on a public registry. Once the SDK is installable,
delete that file and import the same names from the package.

Built against the Web-search backend Extension point specified in
[ADR-0014](https://github.com/willdady/platypus/blob/main/docs/adr/0014-web-search-backend-extension-point.md).
[SearXNG](https://docs.searxng.org/) and
[obscura](https://github.com/h4ckf0r0day/obscura) are separate projects under
their own licenses; this plugin only talks to them over the network.
