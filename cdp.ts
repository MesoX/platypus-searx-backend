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
const PRUNE_JS = `
  var strip = document.querySelectorAll(
    "script, style, noscript, template, svg, iframe, form, button, select, " +
    "link, meta, dialog, [aria-hidden='true'], [hidden]"
  );
  for (var i = 0; i < strip.length; i++) {
    var n = strip[i];
    if (n.parentNode) n.parentNode.removeChild(n);
  }

  var main = null;
  var candidates = document.querySelectorAll("article, main, [role='main']");
  for (var j = 0; j < candidates.length; j++) {
    var text = candidates[j].textContent || "";
    if (text.trim().length > 500) { main = candidates[j]; break; }
  }

  if (main && document.body) {
    document.body.replaceChildren(main);
  } else {
    var chrome = document.querySelectorAll("nav, header, footer, aside");
    for (var k = 0; k < chrome.length; k++) {
      var c = chrome[k];
      if (c.parentNode) c.parentNode.removeChild(c);
    }
  }
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
  return evaluated(read) ?? "";
};

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

const openSocket = (url: string, timeoutMs: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* nothing to do */
      }
      reject(new Error("CDP connection timed out"));
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP connection failed"));
    };
  });

/**
 * Renders `pageUrl` in the browser at `browserUrl` and returns its text.
 *
 * `browserUrl` is the CDP HTTP endpoint (e.g. `http://obscura:9222`). Its
 * `/json/version` advertises a WebSocket URL with a loopback authority — correct
 * from inside the browser's own container, useless from another one — so the
 * authority is rewritten to the one we dialled.
 */
export const renderPage = async (
  browserUrl: string,
  pageUrl: string,
  timeoutMs: number,
  readMode: ReadMode = "markdown",
  prune = true,
): Promise<RenderedPage> => {
  const endpoint = new URL("/json/version", browserUrl);
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(timeoutMs),
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

  const socket = await openSocket(advertised.href, timeoutMs);
  const cdp = new CdpSession(socket, timeoutMs);

  let targetId: string | undefined;
  try {
    const target = (await cdp.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId?: string };
    targetId = target?.targetId;
    if (!targetId) throw new Error("Browser did not open a page target");

    const attached = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };
    const sessionId = attached?.sessionId;
    if (!sessionId)
      throw new Error("Browser did not attach to the page target");

    await cdp.send("Page.enable", {}, sessionId);
    // Arm the load waiter before navigating, or a fast page fires it first.
    const loaded = cdp.waitFor("Page.loadEventFired", sessionId, timeoutMs);
    const navigation = (await cdp.send(
      "Page.navigate",
      { url: pageUrl },
      sessionId,
    )) as { errorText?: string };
    if (navigation?.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }
    await loaded;

    // Prune first, then extract. Both the metadata and the pruning ride one
    // round trip, so the URL cannot belong to a different navigation than the
    // content — and the extractor below sees an already-pruned DOM.
    const meta = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify((function () {
          var url = location.href;
          var contentType = document.contentType;
          ${prune ? PRUNE_JS : ""}
          return { url: url, contentType: contentType };
        })())`,
        returnByValue: true,
      },
      sessionId,
    );
    const metaRaw = evaluated(meta);
    const parsedMeta = metaRaw
      ? (JSON.parse(metaRaw) as { url?: unknown; contentType?: unknown })
      : {};

    const content =
      readMode === "markdown"
        ? await readMarkdown(cdp, sessionId)
        : await readText(cdp, sessionId);

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
    if (targetId) {
      // A target left open is a page the browser keeps running. Best-effort:
      // the read already succeeded or failed, and neither outcome improves by
      // failing here too.
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    cdp.close();
  }
};
