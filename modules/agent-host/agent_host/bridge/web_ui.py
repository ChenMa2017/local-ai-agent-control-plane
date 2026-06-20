from __future__ import annotations

import html
from typing import Sequence


def render_index_html(projects: Sequence[str]) -> str:
    project_options = "\n".join(
        f'<option value="{html.escape(name)}">{html.escape(name)}</option>' for name in sorted(projects)
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Bridge</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #f6f7f9;
      --fg: #1f2933;
      --muted: #667085;
      --line: #ccd3dd;
      --panel: #ffffff;
      --accent: #2563eb;
      --ok: #0f766e;
      --warn: #9a3412;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #101418;
        --fg: #eef2f6;
        --muted: #aab4c0;
        --line: #344150;
        --panel: #171d24;
        --accent: #60a5fa;
        --ok: #2dd4bf;
        --warn: #fdba74;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
    }}
    main {{
      width: min(1040px, calc(100vw - 32px));
      margin: 32px auto;
      display: grid;
      grid-template-columns: minmax(320px, 420px) 1fr;
      gap: 16px;
      align-items: start;
    }}
    h1 {{ font-size: 24px; margin: 0 0 16px; letter-spacing: 0; }}
    h2 {{ font-size: 16px; margin: 0 0 12px; letter-spacing: 0; }}
    section {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }}
    label {{
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 12px;
    }}
    input, select, textarea, button {{
      width: 100%;
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--fg);
      padding: 10px 11px;
    }}
    textarea {{ min-height: 160px; resize: vertical; line-height: 1.45; }}
    button {{
      border-color: var(--accent);
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 650;
    }}
    button:disabled {{
      cursor: wait;
      opacity: 0.65;
    }}
    .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
    .check {{ display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--fg); }}
    .check input {{ width: auto; }}
    .meta {{ color: var(--muted); font-size: 13px; margin: 10px 0 0; overflow-wrap: anywhere; }}
    .pill {{ color: var(--ok); font-weight: 700; }}
    .warn {{ color: var(--warn); }}
    pre {{
      min-height: 360px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.45;
    }}
    .response-tabs {{ display: flex; gap: 8px; margin-bottom: 10px; }}
    .response-tabs button {{ width: auto; padding: 7px 10px; font-size: 12px; background: transparent; color: var(--fg); border-color: var(--line); }}
    .response-tabs button.active {{ background: var(--accent); color: #ffffff; border-color: var(--accent); }}
    .hidden {{ display: none; }}
    .markdown {{
      min-height: 360px;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }}
    .markdown h1, .markdown h2, .markdown h3 {{ margin: 0.6em 0 0.35em; letter-spacing: 0; }}
    .markdown h1 {{ font-size: 22px; }}
    .markdown h2 {{ font-size: 18px; }}
    .markdown h3 {{ font-size: 15px; }}
    .markdown p {{ margin: 0 0 0.65em; }}
    .markdown ul {{ margin: 0 0 0.65em 1.2em; padding: 0; }}
    .markdown code {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }}
    .markdown pre {{ min-height: 0; margin: 0 0 0.75em; overflow-x: auto; }}
    .live {{
      min-height: 360px;
      max-height: 560px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.45;
    }}
    .live-tools {{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; color: var(--muted); font-size: 12px; }}
    .live-tools button {{ width: auto; padding: 6px 9px; font-size: 12px; }}
    .live-tools label {{ display: flex; align-items: center; gap: 6px; margin: 0; }}
    .actions {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }}
    .task-panel {{ margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }}
    .task-title {{ display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }}
    .task-title h2 {{ margin: 0; }}
    .small-btn {{ width: auto; padding: 6px 9px; font-size: 12px; line-height: 1.1; }}
    .task-list {{ display: grid; gap: 8px; }}
    .task-empty {{ color: var(--muted); font-size: 13px; }}
    .task-row {{
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      cursor: pointer;
      background: color-mix(in srgb, var(--panel), var(--bg) 25%);
    }}
    .task-row.selected {{ border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }}
    .task-row-top {{ display: flex; justify-content: space-between; gap: 8px; align-items: center; }}
    .task-id {{ font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }}
    .task-preview {{ margin-top: 6px; color: var(--fg); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }}
    .task-meta {{ margin-top: 5px; color: var(--muted); font-size: 12px; }}
    .task-buttons {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }}
    .task-buttons button {{ padding: 6px 5px; font-size: 12px; }}
    .status-badge {{ border-radius: 999px; padding: 3px 7px; font-size: 11px; font-weight: 700; white-space: nowrap; }}
    .status-queued {{ background: #e5e7eb; color: #374151; }}
    .status-running {{ background: #dbeafe; color: #1d4ed8; }}
    .status-done {{ background: #ccfbf1; color: #0f766e; }}
    .status-failed {{ background: #fee2e2; color: #b91c1c; }}
    .status-cancelled {{ background: #fef3c7; color: #92400e; }}
    .status-timeout {{ background: #ffedd5; color: #c2410c; }}
    .status-cancelling {{ background: #e0e7ff; color: #4338ca; }}
    .status-stale {{ background: #f3f4f6; color: #4b5563; }}
    .status-policy_violation {{ background: #fee2e2; color: #991b1b; }}
    @media (max-width: 800px) {{
      main {{ grid-template-columns: 1fr; }}
      .row, .actions {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Codex Bridge</h1>
      <form id="runForm">
        <label>Token<input id="token" name="token" type="password" autocomplete="off" placeholder="Bearer token"></label>
        <div class="meta">Logged in as: <span id="identity">not authenticated</span></div>
        <label>Project<select id="project" name="project">{project_options}</select></label>
        <label>Prompt<textarea id="prompt" name="prompt">请只读检查 README 和 package.json，总结这个项目是什么</textarea></label>
        <label class="check"><input id="dryRun" name="dry_run" type="checkbox"> Dry run</label>
        <button id="runBtn" type="submit">Run</button>
      </form>
      <div class="meta">Task: <span id="taskId">none</span></div>
      <div class="actions">
        <button id="statusBtn" type="button">Status</button>
        <button id="resultBtn" type="button">Result</button>
        <button id="logsBtn" type="button">Logs</button>
        <button id="cancelBtn" type="button">Cancel</button>
      </div>
      <div class="task-panel">
        <div class="task-title">
          <h2>Recent Tasks</h2>
          <button id="refreshTasksBtn" class="small-btn" type="button">Refresh</button>
        </div>
        <div id="taskList" class="task-list">
          <div class="task-empty">Authenticate to load tasks.</div>
        </div>
      </div>
    </section>
    <section>
      <h2>Response</h2>
      <div class="response-tabs">
        <button id="renderedTab" class="active" type="button">Rendered</button>
        <button id="rawTab" type="button">Raw Safe Text</button>
        <button id="liveTab" type="button">Live Logs</button>
      </div>
      <div id="liveTools" class="live-tools hidden">
        <span>Stream: <span id="streamState">disconnected</span></span>
        <label><input id="autoScroll" type="checkbox" checked> Auto-scroll</label>
        <button id="clearLiveBtn" type="button">Clear</button>
        <button id="reconnectBtn" type="button">Reconnect</button>
      </div>
      <div id="renderedOutput" class="markdown">Ready.</div>
      <pre id="output" class="hidden">Ready.</pre>
      <pre id="liveOutput" class="live hidden"></pre>
    </section>
  </main>
  <script>
    const form = document.getElementById("runForm");
    const output = document.getElementById("output");
    const renderedOutput = document.getElementById("renderedOutput");
    const renderedTab = document.getElementById("renderedTab");
    const rawTab = document.getElementById("rawTab");
    const liveTab = document.getElementById("liveTab");
    const liveTools = document.getElementById("liveTools");
    const liveOutput = document.getElementById("liveOutput");
    const streamState = document.getElementById("streamState");
    const autoScroll = document.getElementById("autoScroll");
    const clearLiveBtn = document.getElementById("clearLiveBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const taskId = document.getElementById("taskId");
    const runBtn = document.getElementById("runBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const identity = document.getElementById("identity");
    const taskList = document.getElementById("taskList");
    const refreshTasksBtn = document.getElementById("refreshTasksBtn");
    const taskStatuses = new Map();
    const fields = ["project", "token"];
    const finalStatuses = new Set(["done", "failed", "cancelled", "timeout", "stale", "policy_violation"]);
    const pollIntervalMs = 1800;
    const maxPolls = 240;
    let responseText = "Ready.";
    let responseMode = "rendered";
    let liveText = "";
    let eventSource = null;
    let currentStreamTask = "";

    function payload(extra = {{}}) {{
      const data = {{
        project: document.getElementById("project").value,
        ...extra
      }};
      return data;
    }}

    function markdownToHTML(text) {{
      const lines = String(text || "").split("\\n");
      let htmlText = "";
      let inCode = false;
      let inList = false;
      let paragraph = [];

      function flushParagraph() {{
        if (paragraph.length) {{
          htmlText += `<p>${{paragraph.join("<br>")}}</p>`;
          paragraph = [];
        }}
      }}
      function closeList() {{
        if (inList) {{
          htmlText += "</ul>";
          inList = false;
        }}
      }}

      for (const rawLine of lines) {{
        const line = rawLine.replace(/\\r$/, "");
        if (line.trim().startsWith("```")) {{
          flushParagraph();
          closeList();
          htmlText += inCode ? "</code></pre>" : "<pre><code>";
          inCode = !inCode;
          continue;
        }}
        if (inCode) {{
          htmlText += `${{escapeHTML(line)}}\\n`;
          continue;
        }}
        if (!line.trim()) {{
          flushParagraph();
          closeList();
          continue;
        }}
        const heading = line.match(/^(#{1,3})\\s+(.+)$/);
        if (heading) {{
          flushParagraph();
          closeList();
          const level = heading[1].length;
          htmlText += `<h${{level}}>${{escapeHTML(heading[2])}}</h${{level}}>`;
          continue;
        }}
        const bullet = line.match(/^[-*]\\s+(.+)$/);
        if (bullet) {{
          flushParagraph();
          if (!inList) {{
            htmlText += "<ul>";
            inList = true;
          }}
          htmlText += `<li>${{escapeHTML(bullet[1])}}</li>`;
          continue;
        }}
        paragraph.push(escapeHTML(line));
      }}
      flushParagraph();
      closeList();
      if (inCode) htmlText += "</code></pre>";
      return htmlText || "Ready.";
    }}

    function paintResponse() {{
      output.textContent = responseText;
      renderedOutput.innerHTML = markdownToHTML(responseText);
      const showRaw = responseMode === "raw";
      const showLive = responseMode === "live";
      output.classList.toggle("hidden", !showRaw);
      renderedOutput.classList.toggle("hidden", showRaw || showLive);
      liveOutput.classList.toggle("hidden", !showLive);
      liveTools.classList.toggle("hidden", !showLive);
      rawTab.classList.toggle("active", showRaw);
      renderedTab.classList.toggle("active", responseMode === "rendered");
      liveTab.classList.toggle("active", showLive);
    }}

    function render(value) {{
      responseText = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      paintResponse();
    }}

    function setStreamState(value) {{
      streamState.textContent = value;
    }}

    function appendLive(line) {{
      const text = String(line || "");
      if (!text) return;
      liveText += text.endsWith("\\n") ? text : `${{text}}\\n`;
      if (liveText.length > 60000) {{
        liveText = `[trimmed live view]\\n${{liveText.slice(-56000)}}`;
      }}
      liveOutput.textContent = liveText;
      if (autoScroll.checked) {{
        liveOutput.scrollTop = liveOutput.scrollHeight;
      }}
    }}

    function closeStream() {{
      if (eventSource) {{
        eventSource.close();
        eventSource = null;
      }}
    }}

    async function connectStream(id, clear = true) {{
      if (!id || id === "none") return;
      closeStream();
      currentStreamTask = id;
      responseMode = "live";
      paintResponse();
      if (clear) {{
        liveText = "";
        liveOutput.textContent = "";
      }}
      setStreamState("requesting token");
      try {{
        const tokenData = await request("/codex/stream-token", {{ task_id: id }});
        const url = `/codex/events?task_id=${{encodeURIComponent(id)}}&stream_token=${{encodeURIComponent(tokenData.stream_token)}}`;
        eventSource = new EventSource(url);
        setStreamState("connecting");

        eventSource.addEventListener("open", () => setStreamState("connected"));
        eventSource.addEventListener("snapshot", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(`[snapshot] ${{data.task_id}} status=${{data.status}} project=${{data.project}}`);
        }});
        eventSource.addEventListener("status", (event) => {{
          const data = JSON.parse(event.data);
          taskStatuses.set(data.task_id, String(data.status || "").toLowerCase());
          updateSelectedTaskControls();
          appendLive(`[status] ${{data.status}}`);
        }});
        eventSource.addEventListener("log", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(data.text || "");
        }});
        eventSource.addEventListener("result", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(`[result] safe result ready for ${{data.task_id}}`);
        }});
        eventSource.addEventListener("done", async (event) => {{
          const data = JSON.parse(event.data);
          setStreamState("completed");
          appendLive(`[done] ${{data.status}}`);
          closeStream();
          await loadTasks();
          await queryForTask("result", data.task_id);
        }});
        eventSource.addEventListener("heartbeat", () => setStreamState("connected"));
        eventSource.addEventListener("error", (event) => {{
          if (event.data) {{
            try {{
              const data = JSON.parse(event.data);
              appendLive(`[error] ${{data.message || event.data}}`);
            }} catch {{
              appendLive(`[error] ${{event.data}}`);
            }}
            setStreamState("error");
          }}
        }});
        eventSource.onerror = () => {{
          if (eventSource) {{
            setStreamState("disconnected");
          }}
        }};
      }} catch (error) {{
        setStreamState("error");
        appendLive(String(error.message || error));
      }}
    }}

    function sleep(ms) {{
      return new Promise((resolve) => setTimeout(resolve, ms));
    }}

    function parseStatus(text) {{
      const match = String(text || "").match(/^status:\\s*([^\\s]+)/m);
      return match ? match[1] : "";
    }}

    function authHeaders(json = true) {{
      const headers = {{}};
      if (json) headers["Content-Type"] = "application/json";
      const token = document.getElementById("token").value.trim();
      if (token) headers["Authorization"] = `Bearer ${{token}}`;
      return headers;
    }}

    function makeIdempotencyKey() {{
      const random =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : `${{Date.now()}}-${{Math.random().toString(16).slice(2)}}`;
      return `web:${{random}}`;
    }}

    function apiErrorMessage(data) {{
      if (data && data.error && data.error.message) return data.error.message;
      if (data && data.text) return data.text;
      if (data && data.error) return JSON.stringify(data.error);
      return JSON.stringify(data);
    }}

    function escapeHTML(value) {{
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({{
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }}[ch]));
    }}

    function taskStatusClass(status) {{
      const safe = String(status || "unknown").toLowerCase();
      if (["queued", "running", "cancelling", "done", "failed", "cancelled", "timeout", "stale", "policy_violation"].includes(safe)) {{
        return `status-${{safe}}`;
      }}
      return "status-queued";
    }}

    function shortTime(value) {{
      return String(value || "").replace("T", " ").replace(/\\.\\d+Z$/, "Z");
    }}

    async function request(path, body) {{
      const response = await fetch(path, {{
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(body)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        throw new Error(apiErrorMessage(data));
      }}
      return data;
    }}

    async function getJson(path) {{
      const response = await fetch(path, {{
        method: "GET",
        headers: authHeaders(false)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        throw new Error(apiErrorMessage(data));
      }}
      return data;
    }}

    async function loadTasks() {{
      if (!document.getElementById("token").value.trim()) {{
        taskList.innerHTML = '<div class="task-empty">Authenticate to load tasks.</div>';
        return;
      }}
      try {{
        const data = await getJson("/codex/tasks?limit=50");
        renderTasks(data.tasks || []);
      }} catch (error) {{
        taskList.innerHTML = `<div class="task-empty">${{escapeHTML(error.message || error)}}</div>`;
      }}
    }}

    function renderTasks(tasks) {{
      taskStatuses.clear();
      if (!tasks.length) {{
        taskList.innerHTML = '<div class="task-empty">No tasks yet.</div>';
        updateSelectedTaskControls();
        return;
      }}
      const selectedId = taskId.textContent.trim();
      taskList.innerHTML = tasks.map((task) => {{
        taskStatuses.set(task.task_id, String(task.status || "").toLowerCase());
        const id = escapeHTML(task.task_id || "");
        const status = escapeHTML(task.status || "unknown");
        const selected = task.task_id === selectedId ? " selected" : "";
        const duration = task.duration_sec === null || task.duration_sec === undefined ? "" : `${{task.duration_sec}}s`;
        const writeInfo = task.mode === "workspace-write"
          ? `write:${{task.changed_files_count ?? 0}}${{task.protected_path_violation ? " protected" : ""}}`
          : "";
        const meta = [task.project, task.source || "unknown", task.mode || "", writeInfo, shortTime(task.created_at), duration].filter(Boolean).join(" | ");
        const canCancel = ["queued", "running"].includes(String(task.status || "").toLowerCase());
        const cancelLabel = String(task.status || "").toLowerCase() === "cancelling" ? "Cancelling" : "Cancel";
        return `
          <div class="task-row${{selected}}" data-task-id="${{id}}">
            <div class="task-row-top">
              <span class="task-id">${{id}}</span>
              <span class="status-badge ${{taskStatusClass(task.status)}}">${{status}}</span>
            </div>
            <div class="task-preview">${{escapeHTML(task.prompt_preview || "(empty prompt)")}}</div>
            <div class="task-meta">${{escapeHTML(meta)}}</div>
            <div class="task-buttons">
              <button type="button" data-command="status">Status</button>
              <button type="button" data-command="result">Result</button>
              <button type="button" data-command="logs">Logs</button>
              <button type="button" data-command="cancel" ${{canCancel ? "" : "disabled"}}>${{cancelLabel}}</button>
            </div>
          </div>
        `;
      }}).join("");
      updateSelectedTaskControls();
    }}

    function updateSelectedTaskControls() {{
      const id = taskId.textContent.trim();
      const status = taskStatuses.get(id);
      const canCancel = Boolean(id && id !== "none" && (!status || ["queued", "running"].includes(status)));
      cancelBtn.disabled = !canCancel;
      cancelBtn.textContent = status === "cancelling" ? "Cancelling" : "Cancel";
    }}

    function selectTask(id, loadResult = false) {{
      taskId.textContent = id;
      taskId.className = "pill";
      for (const row of taskList.querySelectorAll(".task-row")) {{
        row.classList.toggle("selected", row.dataset.taskId === id);
      }}
      updateSelectedTaskControls();
      const status = taskStatuses.get(id);
      if (["queued", "running", "cancelling", "cancel_requested"].includes(status)) {{
        connectStream(id, true);
      }} else if (loadResult) {{
        queryForTask("result", id);
      }}
    }}

    async function whoami() {{
      const response = await fetch("/whoami", {{
        method: "GET",
        headers: authHeaders(false)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        identity.textContent = "not authenticated";
        identity.className = "warn";
        taskList.innerHTML = '<div class="task-empty">Authenticate to load tasks.</div>';
        throw new Error(apiErrorMessage(data));
      }}
      identity.textContent = `${{data.user}} (${{data.role}})`;
      identity.className = "pill";
      await loadTasks();
      return data;
    }}

    form.addEventListener("submit", async (event) => {{
      event.preventDefault();
      runBtn.disabled = true;
      render("Submitting task...");
      try {{
        await whoami();
        const data = await request("/codex/run", payload({{
          prompt: document.getElementById("prompt").value,
          dry_run: document.getElementById("dryRun").checked ? "true" : "false",
          source: "web",
          mode: "readonly",
          source_channel_id: "browser",
          idempotency_key: makeIdempotencyKey(),
          metadata: {{ client: "web-ui" }}
        }}));
        selectTask(data.task_id, false);
        await loadTasks();
        render(`Task ${{data.task_id}} queued.\\n\\nWaiting for final text...`);
        await connectStream(data.task_id, true);
      }} catch (error) {{
        render(String(error.message || error));
      }} finally {{
        runBtn.disabled = false;
      }}
    }});

    async function waitForFinalText(id) {{
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {{
        const statusData = await request("/codex/status", payload({{ task_id: id }}));
        const status = parseStatus(statusData.text);
        const elapsed = `${{attempt + 1}}/${{maxPolls}}`;

        if (status === "done") {{
          const resultData = await request("/codex/result", payload({{ task_id: id }}));
          render(resultData.text || "(empty result)");
          await loadTasks();
          return;
        }}

        if (finalStatuses.has(status)) {{
          const resultData = await request("/codex/result", payload({{ task_id: id }}));
          render(`Task ${{id}} finished with status: ${{status}}\\n\\n${{resultData.text || statusData.text}}`);
          await loadTasks();
          return;
        }}

        render(`Task ${{id}}\\nStatus: ${{status || "unknown"}}\\nPoll: ${{elapsed}}\\n\\n${{statusData.text}}\\n\\nWaiting for final text...`);
        await sleep(pollIntervalMs);
      }}

      render(`Task ${{id}} is still running. Use Status, Result, or Logs to check it later.`);
      await loadTasks();
    }}

    async function queryForTask(command, id) {{
      selectTask(id, false);
      if (!id || id === "none") {{
        render("No task selected.");
        return;
      }}
      if (responseMode === "live") {{
        responseMode = "rendered";
      }}
      render("Loading...");
      try {{
        const data = await request(`/codex/${{command}}`, payload({{ task_id: id }}));
        render(data.text || data);
        if (command === "cancel" || command === "status") await loadTasks();
      }} catch (error) {{
        render(String(error.message || error));
      }}
    }}

    async function query(command) {{
      const id = taskId.textContent.trim();
      await queryForTask(command, id);
    }}

    document.getElementById("statusBtn").addEventListener("click", () => query("status"));
    document.getElementById("resultBtn").addEventListener("click", () => query("result"));
    document.getElementById("logsBtn").addEventListener("click", () => query("logs"));
    document.getElementById("cancelBtn").addEventListener("click", () => query("cancel"));
    renderedTab.addEventListener("click", () => {{
      responseMode = "rendered";
      paintResponse();
    }});
    rawTab.addEventListener("click", () => {{
      responseMode = "raw";
      paintResponse();
    }});
    liveTab.addEventListener("click", () => {{
      responseMode = "live";
      paintResponse();
    }});
    clearLiveBtn.addEventListener("click", () => {{
      liveText = "";
      liveOutput.textContent = "";
    }});
    reconnectBtn.addEventListener("click", () => {{
      const id = taskId.textContent.trim();
      if (id && id !== "none") connectStream(id, false);
    }});
    refreshTasksBtn.addEventListener("click", () => loadTasks());
    taskList.addEventListener("click", (event) => {{
      const row = event.target.closest(".task-row");
      if (!row) return;
      const id = row.dataset.taskId;
      const button = event.target.closest("button[data-command]");
      if (button) {{
        event.stopPropagation();
        queryForTask(button.dataset.command, id);
        return;
      }}
      selectTask(id, true);
    }});

    for (const id of fields) {{
      const saved = sessionStorage.getItem(`codexBridge:${{id}}`);
      const el = document.getElementById(id);
      if (saved && el) el.value = saved;
      if (el) el.addEventListener("change", () => {{
        sessionStorage.setItem(`codexBridge:${{id}}`, el.value);
        if (id === "token") whoami().catch(() => {{}});
        if (id === "project") loadTasks().catch(() => {{}});
      }});
    }}
    if (document.getElementById("token").value.trim()) whoami().catch(() => {{}});
    updateSelectedTaskControls();
    paintResponse();
    loadTasks().catch(() => {{}});
  </script>
</body>
</html>
"""
