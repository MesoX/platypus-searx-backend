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

    // One round trip for all three: a second navigation cannot slip in between
    // the text and the URL it is supposed to belong to.
    const read = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify({
          content: document.body ? document.body.innerText : "",
          url: location.href,
          contentType: document.contentType
        })`,
        returnByValue: true,
      },
      sessionId,
    );

    const raw = evaluated(read);
    if (!raw) throw new Error("Browser returned no page content");
    const page = JSON.parse(raw) as RenderedPage;

    return {
      // Full text: core caps it and owns max_length / start_index slicing.
      content: typeof page.content === "string" ? page.content : "",
      // Post-redirect final URL, so the model cites where it actually landed.
      url: typeof page.url === "string" && page.url ? page.url : pageUrl,
      contentType:
        typeof page.contentType === "string" ? page.contentType : undefined,
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
