// Voice mode for the llama.cpp web UI: mic -> whisper-server -> chat box, replies read aloud.
// Injected into the UI copy by build-voice-ui.py. Needs scripts/start-whisper.ps1 / .sh running.
(() => {
  const WHISPER_URL = `http://${location.hostname}:8081/inference`;
  const VOICE_NOTE =
    "\n\n(Voice input: your answer will be read aloud. Keep it short and conversational, " +
    "no markdown, tables, code or emojis, unless I explicitly ask for them.)";
  const LANGS = { german: "de-DE", english: "en-US", french: "fr-FR", spanish: "es-ES", italian: "it-IT", dutch: "nl-NL", polish: "pl-PL", portuguese: "pt-PT" };
  const SILENCE_END_MS = 1000;
  const NO_SPEECH_TIMEOUT_MS = 8000;
  const MAX_RECORD_MS = 30000;

  const voiceTexts = new Set(); // user messages that came from the mic
  let lang = navigator.language || "en-US";
  let muted = localGet("voice.muted") === "1";
  let rec = null; // active recording
  let state = "idle"; // idle | listening | transcribing | speaking

  function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  // ---------- UI ----------
  const style = document.createElement("style");
  style.textContent = `
    #voice-ctl { position: fixed; right: 16px; bottom: 96px; z-index: 50; display: flex; flex-direction: column; gap: 8px; align-items: center; }
    #voice-ctl button { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--border, #8884); cursor: pointer;
      display: grid; place-items: center; background: var(--background, #fff); color: var(--foreground, #222);
      box-shadow: 0 2px 8px #0002; transition: background .15s, transform .15s; }
    #voice-ctl button:hover { transform: scale(1.06); }
    #voice-ctl #voice-spk { width: 32px; height: 32px; opacity: .8; }
    #voice-ctl[data-state=listening] #voice-mic { background: #dc2626; color: #fff; border-color: #dc2626; animation: voice-pulse 1.2s infinite; }
    #voice-ctl[data-state=transcribing] #voice-mic { background: #d97706; color: #fff; border-color: #d97706; }
    #voice-ctl[data-state=speaking] #voice-mic { background: #2563eb; color: #fff; border-color: #2563eb; }
    #voice-ctl #voice-status { font: 12px system-ui, sans-serif; color: var(--muted-foreground, #666); max-width: 160px; text-align: center; }
    @keyframes voice-pulse { 0%,100% { box-shadow: 0 0 0 0 #dc262666; } 50% { box-shadow: 0 0 0 8px #dc262600; } }`;
  const icon = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const MIC = icon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>');
  const STOP = icon('<rect x="6" y="6" width="12" height="12" rx="2"/>');
  const SPK = icon('<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>');
  const SPK_OFF = icon('<path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/>');

  const ctl = document.createElement("div");
  ctl.id = "voice-ctl";
  ctl.innerHTML = `<div id="voice-status"></div><button id="voice-mic" title="Voice input (Ctrl+Space)"></button><button id="voice-spk"></button>`;
  const micBtn = ctl.querySelector("#voice-mic");
  const spkBtn = ctl.querySelector("#voice-spk");
  const statusEl = ctl.querySelector("#voice-status");

  function setState(s, msg = "") {
    state = s;
    ctl.dataset.state = s;
    micBtn.innerHTML = s === "idle" ? MIC : STOP;
    statusEl.textContent = msg || { listening: "Listening…", transcribing: "Transcribing…", speaking: "" }[s] || "";
  }
  function renderSpk() {
    spkBtn.innerHTML = muted ? SPK_OFF : SPK;
    spkBtn.title = muted ? "Read replies aloud: off" : "Read replies aloud: on";
  }
  function flash(msg) {
    setState("idle", msg);
    setTimeout(() => state === "idle" && (statusEl.textContent = ""), 4000);
  }

  micBtn.onclick = () => {
    if (state === "listening") rec.finish();
    else if (state === "speaking") stopSpeaking();
    else if (state === "idle") listen();
  };
  spkBtn.onclick = () => {
    muted = !muted;
    localSet("voice.muted", muted ? "1" : "0");
    if (muted) stopSpeaking();
    renderSpk();
  };
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.code === "Space") { e.preventDefault(); micBtn.click(); }
    else if (e.key === "Escape" && state === "speaking") stopSpeaking();
  });

  function mount() {
    document.head.appendChild(style);
    document.body.appendChild(ctl);
    setState("idle");
    renderSpk();
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();

  // ---------- recording ----------
  async function listen() {
    stopSpeaking();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      return flash("Microphone blocked");
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const started = performance.now();
    let noise = null, calib = [], speechAt = 0, lastLoud = 0, done = false;

    rec = {
      finish(cancel = false) {
        if (done) return;
        done = true;
        proc.disconnect(); src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        if (cancel || !speechAt) return flash(cancel ? "" : "Didn't hear anything");
        transcribe(encodeWav(downsample(chunks, ctx.sampleRate, 16000), 16000));
      },
    };

    proc.onaudioprocess = (ev) => {
      const data = new Float32Array(ev.inputBuffer.getChannelData(0));
      chunks.push(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (noise === null) { // first ~300 ms: measure background noise
        calib.push(rms);
        if (now - started > 300) noise = Math.max(calib.sort((a, b) => a - b)[calib.length >> 1], 0.003);
        return;
      }
      if (rms > noise * 3) { lastLoud = now; speechAt ||= now; }
      if (speechAt && now - lastLoud > SILENCE_END_MS) rec.finish();
      else if (!speechAt && now - started > NO_SPEECH_TIMEOUT_MS) rec.finish();
      else if (now - started > MAX_RECORD_MS) rec.finish();
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    setState("listening");
  }

  function downsample(chunks, from, to) {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = from / to, out = new Float32Array(Math.floor(len / ratio));
    for (let i = 0; i < out.length; i++) { // average each window to avoid aliasing
      const a = Math.floor(i * ratio), b = Math.min(len, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = a; j < b; j++) s += all[j];
      out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---------- speech to text ----------
  async function transcribe(wav) {
    setState("transcribing");
    const form = new FormData();
    form.append("file", wav, "speech.wav");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    let result;
    try {
      const r = await fetch(WHISPER_URL, { method: "POST", body: form });
      if (!r.ok) throw new Error(r.status);
      result = await r.json();
    } catch (e) {
      return flash("Whisper not reachable – run scripts/start-whisper");
    }
    const text = (result.text || "").trim();
    if (!text || /^[\[(].*[\])]$|^\W*$/.test(text)) return flash("Didn't catch that");
    lang = LANGS[result.language] || lang;
    setState("idle");
    send(text);
  }

  // ---------- put text into the chat box and send ----------
  function send(text) {
    const box = [...document.querySelectorAll("textarea")].filter((t) => t.offsetParent && !t.disabled && !/system message/i.test(t.placeholder)).pop();
    if (!box) return flash("Chat box not found");
    const existing = box.value.trim();
    const full = existing ? `${existing} ${text}` : text;
    voiceTexts.add(full);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, full);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    // the send button enables once the UI has picked up the new value
    let tries = 0;
    const submit = () => {
      const btn = box.closest("form")?.querySelector("button[type=submit]");
      if (btn && !btn.disabled) btn.click();
      else if (++tries < 40) setTimeout(submit, 50);
      else flash("Couldn't send – is a model selected?");
    };
    setTimeout(submit, 50);
  }

  // ---------- read replies aloud: tap the UI's streaming chat requests ----------
  const lastUser = (messages) => [...messages].reverse().find((m) => m.role === "user");
  const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(""));

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    let isVoiceTurn = false;
    if (url.includes("/chat/completions") && !url.includes("/control") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        const user = body.stream && Array.isArray(body.messages) && lastUser(body.messages);
        if (user && voiceTexts.has(textOf(user).trim())) {
          isVoiceTurn = true;
          if (typeof user.content === "string") user.content += VOICE_NOTE;
          else user.content = [...user.content, { type: "text", text: VOICE_NOTE }];
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {}
    }
    const res = await origFetch.call(this, input, init);
    if (!isVoiceTurn || muted || !res.ok || !res.body) return res;
    const [forUi, forVoice] = res.body.tee();
    readAloud(forVoice);
    return new Response(forUi, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  async function readAloud(stream) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let sse = "", pending = "", inCode = false;
    const flush = (final) => {
      // speak complete sentences while the reply is still streaming
      const parts = pending.split(/(?<=[.!?:])\s+|\n+/);
      pending = final ? "" : parts.pop();
      for (const p of parts.concat(final ? [pending] : [])) {
        if (/^\s*```/.test(p)) { inCode = !inCode; continue; }
        if (!inCode) speak(p);
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sse += value;
        const lines = sse.split("\n");
        sse = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            pending += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "";
          } catch {}
        }
        flush(false);
      }
    } catch {}
    flush(true);
  }

  function cleanForSpeech(s) {
    return s
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^\s*(#+|[-*+]|\d+\.|>)\s+/gm, "")
      .replace(/[*_~#|]/g, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .trim();
  }

  function pickVoice() {
    const all = speechSynthesis.getVoices();
    const exact = all.filter((v) => v.lang.toLowerCase() === lang.toLowerCase());
    const sameLang = all.filter((v) => v.lang.slice(0, 2).toLowerCase() === lang.slice(0, 2).toLowerCase());
    // Edge's "Online (Natural)" voices sound far better than the classic desktop ones
    const natural = (vs) => vs.find((v) => /natural/i.test(v.name));
    return natural(exact) || exact[0] || natural(sameLang) || sameLang[0];
  }

  function speak(text) {
    text = cleanForSpeech(text);
    if (!text || muted) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
    u.onstart = () => setState("speaking");
    u.onend = u.onerror = () => { if (!speechSynthesis.pending && !speechSynthesis.speaking) setState("idle"); };
    speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    speechSynthesis.cancel();
    if (state === "speaking") setState("idle");
  }
  speechSynthesis.getVoices(); // voices load lazily
})();
