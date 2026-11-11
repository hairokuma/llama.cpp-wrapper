// Auto-compaction for the llama.cpp web UI. Injected into the UI copy by build-voice-ui.py.
// After every chat reply, reads the tokens used (the stream's `timings`) and, once they pass
// THRESHOLD of the server's context size, runs the UI's own "/compact" (summarize older messages,
// keep the last "Compaction preserved steps" as written). Also kicks in when the server rejects a
// request because the prompt no longer fits.
// build-voice-ui.py exposes the UI's compact function as window.__llamaCompact.
// Threshold override (0.3-0.95), in the browser console: localStorage.setItem("autocompact.threshold", "0.6")
(() => {
  const DEFAULT_THRESHOLD = 0.7; // compaction itself needs headroom: it re-sends the history plus the summary
  const RETRY_MS = 2000; // the UI refuses to compact while a reply / tool loop is running - retry until idle
  const GIVE_UP_MS = 10 * 60 * 1000;

  const threshold = (() => {
    let v = NaN;
    try { v = parseFloat(localStorage.getItem("autocompact.threshold")); } catch {}
    return v >= 0.3 && v <= 0.95 ? v : DEFAULT_THRESHOLD;
  })();

  let nCtx = null;
  let inFlight = 0; // chat requests currently streaming
  let compacting = false; // our compaction call is running (its own requests are not measured)
  let sawRequest = false; // a chat request started while compacting = compaction really ran
  let pending = null; // { page, since } - compaction wanted for this conversation
  let timer = null;

  const log = (...a) => console.info("[autocompact]", ...a);

  async function contextSize() {
    if (nCtx) return nCtx;
    try {
      const r = await realFetch(new URL("props", document.baseURI));
      const n = (await r.json())?.default_generation_settings?.n_ctx;
      if (typeof n === "number" && n > 0) nCtx = n;
    } catch {}
    return nCtx;
  }

  // ---------- small notice ----------
  let toast = null;
  function notify(text, ms = 4000) {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText =
        "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:60;padding:6px 12px;border-radius:8px;" +
        "font:13px system-ui,sans-serif;background:var(--popover,#222);color:var(--popover-foreground,#fff);" +
        "border:1px solid var(--border,#8884);box-shadow:0 2px 8px #0003;pointer-events:none;transition:opacity .3s";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    clearTimeout(toast._t);
    if (ms) toast._t = setTimeout(() => (toast.style.opacity = "0"), ms);
  }

  // ---------- trigger ----------
  function request(reason) {
    if (compacting) return;
    if (typeof window.__llamaCompact !== "function") {
      console.warn("[autocompact] window.__llamaCompact missing - build-voice-ui.py patch did not match (llama.exe UI changed?)");
      return;
    }
    if (!pending || pending.page !== location.href) log("compaction needed:", reason);
    pending = { page: location.href, since: Date.now() };
    schedule(0);
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tryCompact, ms);
  }

  async function tryCompact() {
    if (!pending) return;
    if (pending.page !== location.href || Date.now() - pending.since > GIVE_UP_MS) {
      pending = null; // user switched conversation or it never became idle
      return;
    }
    if (inFlight > 0 || compacting) return schedule(RETRY_MS);
    compacting = true;
    sawRequest = false;
    notify("Context almost full - compacting conversation…", 0);
    try {
      await window.__llamaCompact(); // returns early (no request) while the chat is busy
    } catch (e) {
      console.error("[autocompact] compaction failed:", e);
    } finally {
      compacting = false;
    }
    if (sawRequest) {
      pending = null;
      notify("Conversation compacted");
      log("done");
    } else {
      notify("Waiting to compact…", RETRY_MS);
      schedule(RETRY_MS);
    }
  }

  // ---------- measure: tap streaming chat replies ----------
  async function measure(stream) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", used = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:") || !line.includes('"timings"')) continue;
          try {
            const t = JSON.parse(line.slice(5)).timings;
            if (t) used = (t.cache_n ?? 0) + (t.prompt_n ?? 0) + (t.predicted_n ?? 0);
          } catch {}
        }
      }
    } catch {
      // stream aborted (stop button) - use what we have
    }
    return used;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || "";
    if (!/\/v1\/chat\/completions(\?|$)/.test(url)) return realFetch(input, init);

    const ours = compacting; // the compaction's own requests (and the queued message it sends after)
    if (ours) sawRequest = true;
    inFlight++;
    let res;
    try {
      res = await realFetch(input, init);
    } catch (e) {
      inFlight--;
      throw e;
    }

    if (!res.ok) {
      inFlight--;
      // the prompt no longer fits at all: compact (it leaves out the preserved last steps, so it may still fit)
      if (!ours && res.status === 400) {
        res.clone().json().then((j) => {
          if (j?.error?.n_prompt_tokens && j?.error?.n_ctx) request(`prompt ${j.error.n_prompt_tokens} > n_ctx ${j.error.n_ctx}`);
        }).catch(() => {});
      }
      return res;
    }
    if (!res.body) {
      inFlight--;
      return res;
    }

    const [forUi, forUs] = res.body.tee();
    measure(forUs).then(async (used) => {
      inFlight--;
      if (ours || used == null) return;
      const ctx = await contextSize();
      if (!ctx) return;
      log(`${used} / ${ctx} tokens (${Math.round((100 * used) / ctx)}%)`);
      if (used >= threshold * ctx) request(`${used} / ${ctx} tokens`);
      else if (pending) schedule(RETRY_MS); // a step of a tool loop finished - check again soon
    });
    return new Response(forUi, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
})();
