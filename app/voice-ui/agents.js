// Injected into the llama web UI by build-voice-ui.py.
// Before every chat request, reads AGENTS.md from the conversation's working directory
// (the one set in the UI, else the server's cwd) and appends it to the system message,
// so the model always gets the workspace instructions without having to call a tool.
// (OS, date and time are added server-side by app/chat-template.jinja.)
(() => {
  const CWD_PREFIX = 'Set working directory to ';
  const CWD_CLEARED = 'Working directory cleared';
  const MARKER = '<agents_md path='; // guards against injecting twice
  const realFetch = window.fetch.bind(window);

  const textOf = (c) =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';

  // last "Set working directory to [file://<path>](...)" message wins, same as the UI
  function cwdOf(messages) {
    let cwd = null;
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const t = textOf(m.content).trim();
      if (t === CWD_CLEARED) cwd = null;
      else if (t.startsWith(CWD_PREFIX)) {
        const rest = t.slice(CWD_PREFIX.length);
        const link = rest.match(/^\[file:\/\/([\s\S]*?)\]\(/);
        cwd = link ? link[1] : rest.replace(/\.$/, '');
      }
    }
    return cwd;
  }

  async function readAgents(toolsUrl, cwd, reqHeaders) {
    const headers = { 'Content-Type': 'application/json' };
    const auth = new Headers(reqHeaders || {}).get('Authorization');
    if (auth) headers.Authorization = auth;
    if (cwd) headers['x-tool-cwd'] = cwd;
    try {
      const r = await realFetch(toolsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool: 'read_file', params: { path: 'AGENTS.md' } }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j.plain_text_response === 'string' ? j.plain_text_response : null;
    } catch {
      return null;
    }
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    if (!url || !/\/v1\/chat\/completions(\?|$)/.test(url) || typeof init?.body !== 'string') {
      return realFetch(input, init);
    }
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      return realFetch(input, init);
    }
    const msgs = body.messages;
    if (!Array.isArray(msgs) || msgs.some((m) => textOf(m.content).includes(MARKER))) {
      return realFetch(input, init);
    }
    const toolsUrl = url.replace(/\/v1\/chat\/completions(\?.*)?$/, '/tools');
    const cwd = cwdOf(msgs);
    const agents = await readAgents(toolsUrl, cwd, init.headers);
    if (agents && agents.trim()) {
      const sep = cwd && cwd.includes('\\') ? '\\' : '/'; // Windows or POSIX working directory
      const path = cwd ? `${cwd.replace(/[\\/]+$/, '')}${sep}AGENTS.md` : 'AGENTS.md';
      const block =
        `# Workspace instructions (mandatory)\n` +
        `The user's workspace contains this AGENTS.md. Obey it in every answer of this conversation, ` +
        `starting with your very first reply - it has priority over your default behaviour:\n` +
        `${MARKER}"${path}">\n${agents.trim()}\n</agents_md>`;
      if (msgs[0]?.role === 'system') {
        msgs[0] = { ...msgs[0], content: `${textOf(msgs[0].content)}\n\n${block}` };
      } else {
        msgs.unshift({ role: 'system', content: block });
      }
      // also prefix the first real user message: small models follow it far more reliably there
      // (only in the request sent to the server; the stored conversation is unchanged)
      const first = msgs.findIndex((m) => {
        if (m.role !== 'user') return false;
        const t = textOf(m.content).trim();
        return !t.startsWith(CWD_PREFIX) && t !== CWD_CLEARED;
      });
      if (first >= 0) {
        const note = `${block}\n\n`;
        const c = msgs[first].content;
        msgs[first] = {
          ...msgs[first],
          content: Array.isArray(c) ? [{ type: 'text', text: note }, ...c] : note + textOf(c),
        };
      }
      init = { ...init, body: JSON.stringify(body) };
    }
    return realFetch(input, init);
  };
})();
