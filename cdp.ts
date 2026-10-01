// A minimal Chrome DevTools Protocol client, just enough to render a page and
// read its text out of a headless browser (obscura).
//
// Deliberately not puppeteer-core or chrome-remote-interface: read_url needs
// four commands and one event, Node ships a global WebSocket, and the plugin is
// installed as a bind-mounted directory carrying its own node_modules — every
// dependency added here is one the operator has to install by hand.

interface CdpResponse {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What a rendered page yields. `content` is full text — core does the slicing. */
export interface RenderedPage {
  content: string;
  url: string;
  contentType?: string;
}

/** `markdown` keeps headings and links; `text` is flat prose. */
export type ReadMode = "markdown" | "text";

/** A heading as the pruned DOM has it — text mode has no heading syntax to parse. */
export interface Heading {
  level: number;
  text: string;
}

/** The page before shaping: what the browser gave us, plus its DOM headings. */
export interface ExtractedPage extends RenderedPage {
  headings: Heading[];
}

/**
 * Removes what is on the page but is not the page, in the document we are about
 * to throw away.
 *
 * Two separate problems, both observed against real news sites:
 *
 * 1. **Non-content nodes leaking in as text.** `document.body.innerText` is
 *    supposed to honour the UA stylesheet's `display: none` on `script`,
 *    `style` and `noscript`. This browser's does not, so pages came back
 *    starting with GTM `<noscript><iframe>` markup and inline analytics source.
 *    Removing the nodes fixes it for every extractor rather than relying on one.
 * 2. **Boilerplate crowding out the article.** Core's default page is 5000
 *    characters. On a news homepage that is entirely nav, cookie banners and
 *    section menus — the model pages through junk to reach the first sentence.
 *    So: prefer an `<article>` / `<main>` when the page marks one up and it
 *    holds real text, else drop the chrome landmarks.
 *
 * The 500-character floor on the chosen landmark is the guard against a site
 * that ships an empty `<main>` and puts its content elsewhere — a wrong guess
 * there would throw the page away.
 */
const pruneJs = (readMode: ReadMode): string => `
  var IMAGES_AS_ALT = ${readMode === "markdown"};

  function drop(selector) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  // Never content, and the source of the leakage: inline analytics, CSS, and
  // JSON-LD all came back as page text.
  drop(
    "script, style, noscript, template, svg, iframe, form, button, select, " +
    "textarea, link, meta, dialog, [aria-hidden='true'], [hidden]"
  );

  // Resolve every link and image against the document BEFORE extraction. The
  // markdown converter reads the raw href attribute, which on most sites is
  // relative ("/willdady/platypus/issues") — and core's read_url input is
  // z.string().url(), so a relative href reaches the model as a link it cannot
  // follow. The .href / .src properties are already absolute; copying them back
  // onto the attributes is what makes a markdown page navigable.
  var links = document.querySelectorAll("a[href]");
  for (var li = 0; li < links.length; li++) {
    try { links[li].setAttribute("href", links[li].href); } catch (e) {}
  }
  // An image src is unusable by definition — read_url hands text to a model
  // that cannot open a PNG — and it is not cheap: a README's badges are
  // ~100-character camo URLs and the markdown converter emits every one.
  //
  // What replaces it depends on the mode, because the two extractors disagree
  // about images already. Markdown keeps the alt text: it is often the only
  // label a badge link has, and dropping the image outright makes the converter
  // discard the surrounding link as empty. Flat text drops them, because
  // innerText never included them and injecting alt text there measured +67% on
  // a news index for captions the prose does not need.
  var imgs = document.querySelectorAll("img");
  for (var ii = 0; ii < imgs.length; ii++) {
    var img = imgs[ii];
    if (!img.parentNode) continue;
    var alt = IMAGES_AS_ALT ? (img.getAttribute("alt") || "").trim() : "";
    img.parentNode.replaceChild(document.createTextNode(alt), img);
  }

  // Chrome landmarks go unconditionally, not just on the fallback path. A
  // <main> usually contains the site's own nav (GitHub's repository tabs live
  // inside it), so picking a landmark is not on its own enough to shed them.
  drop("nav, header, footer, aside");

  function biggest(selector) {
    var nodes = document.querySelectorAll(selector);
    var best = null, bestLen = 0, qualifying = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = (nodes[i].textContent || "").trim().length;
      if (len <= 500) continue;
      qualifying++;
      if (len > bestLen) { best = nodes[i]; bestLen = len; }
    }
    return { node: best, count: qualifying };
  }

  // <article> wins when the page marks up one or two of them, even when it is a
  // small share of the text: on a repository page the README is the article and
  // is 12% of the body, while <main> is 88% and mostly file lists. But an index
  // page marks up every teaser as an <article>, and picking the largest teaser
  // would throw the rest away — hence the count guard, not a size threshold.
  var article = biggest("article");
  var chosen =
    article.node && article.count <= 2
      ? article.node
      : (biggest("[role='main']").node || biggest("main").node);

  if (chosen && document.body) document.body.replaceChildren(chosen);
`;

/**
 * Asks the browser for markdown via obscura's `LP.getMarkdown`, falling back to
 * text if the method is not there.
 *
 * `LP` is obscura's own CDP domain, not a standard one, so any other
 * Chrome-protocol browser answers `-32601 Unknown domain`. The fallback is what
 * keeps `browserUrl` pointable at plain headless Chrome. It takes no params —
 * hence the pruning above, which is the only way to scope what it converts.
 */
const readMarkdown = async (
  cdp: CdpSession,
  sessionId: string,
): Promise<string> => {
  try {
    const result = (await cdp.send("LP.getMarkdown", {}, sessionId)) as {
      markdown?: unknown;
    };
    const markdown =
      typeof result?.markdown === "string"
        ? normaliseMarkdown(result.markdown)
        : "";
    if (markdown.length > 0) return markdown;
    // An empty string is not an error — a genuinely blank page reads the same
    // way — but there is nothing to lose by trying the other extractor.
    return await readText(cdp, sessionId);
  } catch {
    return await readText(cdp, sessionId);
  }
};

/**
 * Flat text. `innerText` first because it respects layout (a table reads as
 * rows, not as one run-on line), `textContent` only if the browser gives us
 * nothing — after pruning, the difference no longer includes script bodies.
 */
const readText = async (
  cdp: CdpSession,
  sessionId: string,
): Promise<string> => {
  const read = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(function () {
        var root = document.body || document.documentElement;
        if (!root) return "";
        var t = root.innerText;
        if (typeof t === "string" && t.trim().length > 0) return t;
        return root.textContent || "";
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  return normalise(evaluated(read) ?? "");
};

/**
 * Collapses the whitespace this browser's `innerText` leaves behind — a
 * repository page came back with runs of a dozen blank lines between two words.
 * Core's default page is 5000 characters and it counts every one of them, so
 * indentation the model cannot see is budget it cannot spend.
 *
 * Text mode. Markdown has its own pass below, because indentation means
 * something inside a code fence.
 */
const normalise = (text: string): string =>
  text
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The markdown counterpart of `normalise`. obscura's converter copies text
 * nodes verbatim, so the site's own source indentation comes through: lines of
 * nothing but tabs, which its blank-line collapsing does not see as blank. On
 * CNN they were over half of the first 5000 characters.
 *
 * The converter never starts its own syntax with whitespace — headings, list
 * items, quotes, table rows and fences all begin at column 0 — so outside a
 * fence a line's surrounding whitespace is never markdown and goes, and runs
 * inside it collapse as HTML would render them. Inside a fence indentation is
 * the content, so only trailing whitespace goes there.
 */
export const normaliseMarkdown = (markdown: string): string => {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced;
        return line.trimEnd();
      }
      return fenced
        ? line.trimEnd()
        : line.replace(/[ \t ]+/g, " ").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const evaluated =(result: unknown): string | undefined => {
  const value = (result as { result?: { value?: unknown } } | undefined)?.result
    ?.value;
  return typeof value === "string" ? value : undefined;
};

// --- Shaping: making core's first page worth reading -----------------------
//
// Core serves read_url in pages — `max_length` defaults to 5000 characters and
// the rest is reached with `start_index`. Models mostly take the default, so the
// first 5000 characters decide what a read is worth. Two things spend them badly:
//
// 1. **Link targets.** obscura's converter writes every anchor inline as
//    `[label](https://…)`, and the URL is usually longer than the label. On a
//    link-dense page most of the first page is URLs.
// 2. **No sense of the rest.** A model reading characters 0-5000 of a 150 000
//    character page cannot tell which `start_index` holds what it came for, so
//    it either stops or pages blindly.
//
// So markdown links become references collected in a footer, and a long page
// opens with a map of its headings and where the footer starts. Neither drops
// content: every label stays where it was, every distinct target is still
// listed, and the map only adds offsets.

/** Core's default `read_url` page — `max_length`'s default. */
const DEFAULT_PAGE_CHARS = 5_000;
/** The most of the first page the map may take. */
const MAP_BUDGET_CHARS = 1_200;
const MAP_HEADING_CHARS = 80;

// The converter emits `'[' + label.trim() + '](' + href + ')'` with no escaping,
// so the label may hold one level of brackets (Wikipedia's `[[1]](…)` citation
// links) and the URL may hold balanced parentheses (`/wiki/Foo_(bar)`). URLs
// never hold whitespace — pruning copied `.href`, which is already serialised.
// Each alternation starts on a distinct character, so matching stays linear.
const INLINE_LINK =
  /\[((?:[^[\]]|\[[^[\]]*\])*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)/g;
const REFERENCE_LINK = /\[((?:[^[\]]|\[[^[\]]*\])*)\]\[L\d+\]/g;

const withoutFragment = (url: string): string => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

/**
 * `[label](url)` → `[label][Ln]`, with `[Ln]: url` collected in a footer, one
 * per distinct target in order of first use.
 *
 * The `L` is load-bearing: pages keep their own bracketed numbers as text —
 * Wikipedia's `[1]` citation markers survive as labels — and a bare `[1]` is
 * markdown's shortcut syntax for definition `[1]`. Numeric ids would make every
 * footnote marker read as a link to some unrelated target.
 *
 * Links back into the same document become their label alone. They cannot be
 * followed to anything new — `read_url` on them returns this page again — and
 * they are not rare: Wikipedia's citation markers alone are hundreds per article.
 */
const toReferenceLinks = (
  markdown: string,
  pageUrl: string,
): { body: string; footer: string; count: number } => {
  const page = withoutFragment(pageUrl);
  const ids = new Map<string, number>();
  const body = markdown.replace(
    INLINE_LINK,
    (_match, label: string, url: string) => {
      if (withoutFragment(url) === page) return label;
      let id = ids.get(url);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(url, id);
      }
      return `[${label}][L${id}]`;
    },
  );
  if (ids.size === 0) return { body, footer: "", count: 0 };
  const definitions = [...ids].map(([url, id]) => `[L${id}]: ${url}`);
  return {
    body,
    footer: `\n\n---\nLinks:\n${definitions.join("\n")}`,
    count: ids.size,
  };
};

interface MapEntry {
  offset: number;
  level: number;
  text: string;
}

const plainHeading = (text: string): string => {
  const plain = text
    .replace(REFERENCE_LINK, "$1")
    .replace(INLINE_LINK, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAP_HEADING_CHARS
    ? `${plain.slice(0, MAP_HEADING_CHARS - 1)}…`
    : plain;
};

/** ATX headings, outside fenced code — the converter emits nothing else. */
const markdownHeadings = (markdown: string): MapEntry[] => {
  const entries: MapEntry[] = [];
  let offset = 0;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6}) (.*\S)/.exec(line);
    if (match) {
      const text = plainHeading(match[2]);
      if (text) entries.push({ offset, level: match[1].length, text });
    }
    offset += line.length + 1;
  }
  return entries;
};

/**
 * Finds the DOM's headings in flat text, in order. A heading `innerText` broke
 * across lines, or that normalisation changed, is skipped rather than guessed:
 * a missing map entry costs the model a page, a wrong offset costs it trust.
 */
const locateHeadings = (text: string, headings: Heading[]): MapEntry[] => {
  const entries: MapEntry[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const needle = heading.text.replace(/\s+/g, " ").trim();
    if (!needle) continue;
    const at = text.indexOf(needle, cursor);
    if (at < 0) continue;
    entries.push({
      offset: at,
      level: heading.level,
      text: plainHeading(needle),
    });
    cursor = at + needle.length;
  }
  return entries;
};

const renderMap = (
  entries: MapEntry[],
  omitted: number,
  links: { offset: number; count: number } | undefined,
  prefix: number,
  total: number,
): string => {
  const top = Math.min(6, ...entries.map((e) => e.level));
  const lines = [
    `[Page map: ${total} characters. Each number is a start_index to read from.]`,
    ...entries.map(
      (e) => `${prefix + e.offset} ${"  ".repeat(e.level - top)}${e.text}`,
    ),
  ];
  if (omitted > 0) lines.push(`… ${omitted} more headings`);
  if (links) {
    lines.push(`${prefix + links.offset} Links: targets [L1]-[L${links.count}]`);
  }
  lines.push("[End of page map]");
  return `${lines.join("\n")}\n\n`;
};

/**
 * Picks what fits the budget: the top three heading levels, then fewer levels,
 * then the first top-level headings in order. Sized with offsets at their widest, so the
 * offset fix-up below can only shrink the result.
 */
const fitMap = (
  entries: MapEntry[],
  links: { offset: number; count: number } | undefined,
  total: number,
): { entries: MapEntry[]; omitted: number } => {
  const widest = total + MAP_BUDGET_CHARS;
  const size = (chosen: MapEntry[], omitted: number) =>
    renderMap(chosen, omitted, links, widest, widest).length;
  const top = Math.min(6, ...entries.map((e) => e.level));
  for (let depth = 2; depth >= 0; depth--) {
    const chosen = entries.filter((e) => e.level <= top + depth);
    if (size(chosen, 0) <= MAP_BUDGET_CHARS) {
      return { entries: chosen, omitted: entries.length - chosen.length };
    }
  }
  // Even the top level does not fit: keep its first headings, in order.
  const chosen: MapEntry[] = [];
  for (const entry of entries.filter((e) => e.level === top)) {
    const rest = entries.length - chosen.length - 1;
    if (size([...chosen, entry], rest) > MAP_BUDGET_CHARS) break;
    chosen.push(entry);
  }
  return { entries: chosen, omitted: entries.length - chosen.length };
};

export interface ShapeOptions {
  readMode: ReadMode;
  pageUrl: string;
  headings: Heading[];
  pageMap: boolean;
  linkFooter: boolean;
}

/**
 * Applies the link footer (markdown only) and the page map (any page longer
 * than core's default page) to extracted content.
 */
export const shapeContent = (
  content: string,
  options: ShapeOptions,
): string => {
  let body = content;
  let footer = "";
  let linkCount = 0;
  if (options.linkFooter && options.readMode === "markdown") {
    ({ body, footer, count: linkCount } = toReferenceLinks(
      content,
      options.pageUrl,
    ));
  }
  const shaped = body + footer;
  if (!options.pageMap || shaped.length <= DEFAULT_PAGE_CHARS) return shaped;

  const headings =
    options.readMode === "markdown"
      ? markdownHeadings(body)
      : locateHeadings(body, options.headings);
  const links = footer
    ? { offset: body.length + footer.indexOf("Links:"), count: linkCount }
    : undefined;
  if (headings.length === 0 && !links) return shaped;

  const { entries, omitted } = fitMap(headings, links, shaped.length);
  // Offsets count the map itself, whose length depends on how many digits
  // they have. Widths only grow with the prefix, so this settles in a pass or two.
  let prefix = 0;
  let map = "";
  for (let pass = 0; pass < 8; pass++) {
    map = renderMap(entries, omitted, links, prefix, prefix + shaped.length);
    if (map.length === prefix) break;
    prefix = map.length;
  }
  return map + shaped;
};

class CdpSession {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #waiters: { method: string; sessionId?: string; resolve: () => void }[] = [];
  #commandTimeoutMs: number;

  constructor(socket: WebSocket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.onmessage = (event: MessageEvent) => this.#onMessage(event);
    socket.onclose = () => this.#failAll(new Error("CDP socket closed"));
  }

  #onMessage(event: MessageEvent): void {
    let msg: CdpResponse;
    try {
      msg = JSON.parse(String(event.data)) as CdpResponse;
    } catch {
      return; // A frame we cannot parse is not ours to act on.
    }

    if (typeof msg.id === "number") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "CDP command failed"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    for (const waiter of [...this.#waiters]) {
      if (
        waiter.method === msg.method &&
        (waiter.sessionId === undefined || waiter.sessionId === msg.sessionId)
      ) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  #failAll(cause: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.#commandTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /**
   * Resolves on the next matching event, or on timeout — deliberately *not* a
   * rejection. A page that never fires `load` (a hung tracker, a stream) is
   * still worth reading whatever it rendered, so the caller falls through to
   * the read rather than failing the turn.
   */
  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = { method, sessionId, resolve };
      this.#waiters.push(waiter);
      setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) {
          this.#waiters.splice(i, 1);
          resolve();
        }
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Already closing; nothing to salvage.
    }
  }
}

// Node's global WebSocket (undici) takes a non-standard second argument with
// request headers; the DOM typing only knows subprotocols. This is the one way
// to put a bearer token on the upgrade request. Verified on Node 26.
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  init?: { headers?: Record<string, string> },
) => WebSocket;

const openSocket = (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  headers: Record<string, string> | undefined,
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = new NodeWebSocket(url, headers ? { headers } : undefined);
    const giveUp = (cause: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        /* nothing to do */
      }
      reject(cause);
    };
    // Closed here rather than raced from outside: a socket that opened after
    // the caller stopped waiting would have no one left to close it.
    const onAbort = () => giveUp(signal.reason);
    const timer = setTimeout(
      () => giveUp(new Error("CDP connection timed out")),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    };
    socket.onerror = () => giveUp(new Error("CDP connection failed"));
  });

/**
 * Renders `pageUrl` in the browser at `browserUrl` and returns its text,
 * shaped for core's paging (see `shapeContent`). Same arguments as
 * `extractPage`, which does the browser work.
 */
export const renderPage = async (
  browserUrl: string,
  pageUrl: string,
  timeoutMs: number,
  readMode: ReadMode,
  prune: boolean,
  signal: AbortSignal,
  browserToken?: string,
): Promise<RenderedPage> => {
  const { headings, ...page } = await extractPage(
    browserUrl,
    pageUrl,
    timeoutMs,
    readMode,
    prune,
    signal,
    browserToken,
  );
  return {
    ...page,
    content: shapeContent(page.content, {
      readMode,
      pageUrl: page.url,
      headings,
      pageMap: true,
      linkFooter: true,
    }),
  };
};

/**
 * Renders `pageUrl` in the browser at `browserUrl` and returns its text as
 * extracted, unshaped.
 *
 * `browserUrl` is the CDP HTTP endpoint (e.g. `http://obscura:9222`). Its
 * `/json/version` advertises a WebSocket URL with a loopback authority — correct
 * from inside the browser's own container, useless from another one — so the
 * authority is rewritten to the one we dialled.
 *
 * `browserToken`, when set, goes out as `Authorization: Bearer` on both the
 * discovery request and the WebSocket upgrade — obscura checks it on each.
 *
 * `signal` is core's: it fires when the turn is cancelled or the backend's
 * `timeoutMs` passes. The render then stops at its next step, and the tab it
 * opened is still closed — an abandoned read must not leave a page loading in
 * the browser.
 */
export const extractPage = async (
  browserUrl: string,
  pageUrl: string,
  timeoutMs: number,
  readMode: ReadMode,
  prune: boolean,
  signal: AbortSignal,
  browserToken?: string,
): Promise<ExtractedPage> => {
  signal.throwIfAborted();

  const auth = browserToken
    ? { Authorization: `Bearer ${browserToken}` }
    : undefined;
  const endpoint = new URL("/json/version", browserUrl);
  const response = await fetch(endpoint, {
    headers: auth,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
  });
  if (!response.ok) {
    throw new Error(
      `Browser responded ${response.status} ${response.statusText} at ${endpoint.href}`,
    );
  }
  const version = (await response.json()) as {
    webSocketDebuggerUrl?: unknown;
  };
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("Browser did not advertise a webSocketDebuggerUrl");
  }

  const advertised = new URL(version.webSocketDebuggerUrl);
  const dialled = new URL(browserUrl);
  advertised.protocol = dialled.protocol === "https:" ? "wss:" : "ws:";
  advertised.host = dialled.host;

  const socket = await openSocket(advertised.href, timeoutMs, signal, auth);
  const cdp = new CdpSession(socket, timeoutMs);

  // Each step below is raced against the abort, so a cancelled read stops
  // waiting at once. The socket deliberately stays open through it: `finally`
  // still needs it to close the tab.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    // An abort that landed between awaits has already fired its event.
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {}); // Observed by the races; never unhandled.
  const step = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, aborted]);

  let targetId: string | undefined;
  try {
    // Not raced: a target created after we stopped waiting would come back
    // with an id nobody holds, and stay open. Let it land, then check.
    const target = (await cdp.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId?: string };
    targetId = target?.targetId;
    if (!targetId) throw new Error("Browser did not open a page target");
    signal.throwIfAborted();

    const attached = (await step(
      cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      }),
    )) as { sessionId?: string };
    const sessionId = attached?.sessionId;
    if (!sessionId)
      throw new Error("Browser did not attach to the page target");

    await step(cdp.send("Page.enable", {}, sessionId));
    // Arm the load waiter before navigating, or a fast page fires it first.
    const loaded = cdp.waitFor("Page.loadEventFired", sessionId, timeoutMs);
    const navigation = (await step(
      cdp.send("Page.navigate", { url: pageUrl }, sessionId),
    )) as { errorText?: string };
    if (navigation?.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }
    await step(loaded);

    // Prune first, then extract. Both the metadata and the pruning ride one
    // round trip, so the URL cannot belong to a different navigation than the
    // content — and the extractor below sees an already-pruned DOM.
    const meta = await step(
      cdp.send(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify((function () {
          var url = location.href;
          var contentType = document.contentType;
          ${prune ? pruneJs(readMode) : ""}
          // After pruning, so a heading the page map lists is one the
          // extractor kept.
          var headings = [];
          var hs = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
          for (var hi = 0; hi < hs.length; hi++) {
            var ht = (hs[hi].textContent || "").replace(/\\s+/g, " ").trim();
            if (ht) {
              headings.push({ level: +hs[hi].tagName.charAt(1), text: ht.slice(0, 200) });
            }
          }
          return { url: url, contentType: contentType, headings: headings };
        })())`,
          returnByValue: true,
        },
        sessionId,
      ),
    );
    const metaRaw = evaluated(meta);
    const parsedMeta = metaRaw
      ? (JSON.parse(metaRaw) as {
          url?: unknown;
          contentType?: unknown;
          headings?: unknown;
        })
      : {};

    const content = await step(
      readMode === "markdown"
        ? readMarkdown(cdp, sessionId)
        : readText(cdp, sessionId),
    );

    return {
      // Full content: core caps it and owns max_length / start_index slicing.
      content,
      // Post-redirect final URL, so the model cites where it actually landed.
      url:
        typeof parsedMeta.url === "string" && parsedMeta.url
          ? parsedMeta.url
          : pageUrl,
      contentType:
        typeof parsedMeta.contentType === "string"
          ? parsedMeta.contentType
          : undefined,
      headings: Array.isArray(parsedMeta.headings)
        ? (parsedMeta.headings as Heading[])
        : [],
    };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (targetId) {
      // A target left open is a page the browser keeps running. Best-effort:
      // the read already succeeded or failed, and neither outcome improves by
      // failing here too.
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    cdp.close();
  }
};
