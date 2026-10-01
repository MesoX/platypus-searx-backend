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
    if (typeof result?.markdown === "string" && result.markdown.length > 0) {
      return result.markdown;
    }
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
 * Text mode only. Markdown is left alone: leading spaces are syntax there, and
 * obscura's converter already collapses blank-line runs.
 */
const normalise = (text: string): string =>
  text
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const evaluated = (result: unknown): string | undefined => {
  const value = (result as { result?: { value?: unknown } } | undefined)?.result
    ?.value;
  return typeof value === "string" ? value : undefined;
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

const openSocket = (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = new WebSocket(url);
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
 * Renders `pageUrl` in the browser at `browserUrl` and returns its text.
 *
 * `browserUrl` is the CDP HTTP endpoint (e.g. `http://obscura:9222`). Its
 * `/json/version` advertises a WebSocket URL with a loopback authority — correct
 * from inside the browser's own container, useless from another one — so the
 * authority is rewritten to the one we dialled.
 *
 * `signal` is core's: it fires when the turn is cancelled or the backend's
 * `timeoutMs` passes. The render then stops at its next step, and the tab it
 * opened is still closed — an abandoned read must not leave a page loading in
 * the browser.
 */
export const renderPage = async (
  browserUrl: string,
  pageUrl: string,
  timeoutMs: number,
  readMode: ReadMode,
  prune: boolean,
  signal: AbortSignal,
): Promise<RenderedPage> => {
  signal.throwIfAborted();

  const endpoint = new URL("/json/version", browserUrl);
  const response = await fetch(endpoint, {
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

  const socket = await openSocket(advertised.href, timeoutMs, signal);
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
          return { url: url, contentType: contentType };
        })())`,
          returnByValue: true,
        },
        sessionId,
      ),
    );
    const metaRaw = evaluated(meta);
    const parsedMeta = metaRaw
      ? (JSON.parse(metaRaw) as { url?: unknown; contentType?: unknown })
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
