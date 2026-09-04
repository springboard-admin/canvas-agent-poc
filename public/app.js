// Study Agent SPA — Phase 1: conversational, state-aware, delightful & lite.
// Memory is client-side: we keep the transcript here and resend it each turn.
(function () {
  const boot = window.__BOOT__ || { name: "there", course: "" };
  const root = document.getElementById("root");

  // ---- state ----
  const transcript = []; // {role, content}
  let energy = null;     // "low" | "ok" | "high" | null
  let busy = false;

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  root.innerHTML = `
    <div class="hero">
      <div class="orb" id="orb"></div>
      <h1>${greet}, ${esc(firstName(boot.name))}.</h1>
    </div>
    <div class="chips" id="chips"></div>
    <div class="stream" id="stream"></div>
    <div class="composer">
      <input id="q" placeholder="Ask me anything…" autocomplete="off"/>
      <button id="send" aria-label="Send">→</button>
    </div>
  `;

  const stream = document.getElementById("stream");
  const input = document.getElementById("q");
  const orb = document.getElementById("orb");

  function firstName(n) { return String(n || "there").split(/[\s(]/)[0] || "there"; }

  const chips = [
    { label: "How am I doing?", q: "How am I doing?" },
    { label: "I've got 15 minutes", q: "I have 15 minutes right now" },
    { label: "What should I do today?", q: "What should I focus on today?" },
    { label: "Help me catch up", q: "I feel behind — help me catch up" },
  ];
  const chipWrap = document.getElementById("chips");
  chips.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c.label;
    b.onclick = () => ask(c.q);
    chipWrap.appendChild(b);
  });

  document.getElementById("send").onclick = submit;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  // ---- last-visit memory (client-side, no infra) ----
  const MEM_KEY = "sa_last_" + (boot.uid || "anon") + "_" + (boot.course || "");
  function readMem() {
    try { return JSON.parse(localStorage.getItem(MEM_KEY) || "null"); } catch { return null; }
  }
  function touchMem() {
    try { localStorage.setItem(MEM_KEY, JSON.stringify({ ts: Date.now() })); } catch { /* storage blocked */ }
  }

  // ---- proactive personalized greeting on load ----
  greetOnLoad();

  async function greetOnLoad() {
    const mem = readMem();
    const signals = {};
    if (mem && typeof mem.ts === "number") {
      signals.daysAway = Math.floor((Date.now() - mem.ts) / 86400000);
    }
    busy = true;
    const thinking = addThinking();
    orb.classList.add("thinking");
    try {
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [], energy, mode: "greeting", signals }),
      });
      const data = await r.json();
      thinking.remove();
      if (!r.ok) return; // stay quiet on greeting failure; user can still ask
      // Opening is a warm hook only — no task card. We let a task emerge naturally
      // after a couple of exchanges.
      if (data.say) { addAgent(data.say); transcript.push({ role: "assistant", content: data.say }); }
      touchMem();
      scrollEnd();
    } catch {
      thinking.remove();
    } finally {
      busy = false;
      orb.classList.remove("thinking");
    }
  }

  function submit() {
    const v = input.value.trim();
    if (!v || busy) return;
    input.value = "";
    ask(v);
  }

  async function ask(message) {
    if (busy) return;
    busy = true;
    hideIntro();
    addUser(message);
    transcript.push({ role: "user", content: message });
    const thinking = addThinking();
    orb.classList.add("thinking");
    try {
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: transcript, energy }),
      });
      const data = await r.json();
      thinking.remove();
      if (!r.ok) { addError(data.error || "Something went wrong."); return; }
      transcript.push({ role: "assistant", content: data.say || "" });
      render(data);
      touchMem();
    } catch (e) {
      thinking.remove();
      addError(e.message);
    } finally {
      busy = false;
      orb.classList.remove("thinking");
    }
  }

  function render(data) {
    if (data.say) addAgent(data.say);

    if (data.celebrate) addCelebrate();

    // Status card only when they asked about standing.
    if (data.intent === "status" && data.status) addStatus(data.status);

    // The hero: one clear next action.
    if (data.nextAction) addNextAction(data.nextAction);

    if (data.special) addSpecial(data.special);

    scrollEnd();
  }

  // ---- renderers ----
  function addNextAction(a) {
    const el = card(`
      <div class="k">Your next step</div>
      <div class="next-title">${esc(a.title)}</div>
      <div class="next-meta">${a.minutes ? "~" + a.minutes + " min" : ""}${a.minutes && a.why ? " · " : ""}${a.why ? esc(a.why) : ""}</div>
      ${a.url ? `<a class="start" href="${a.url}" target="_blank" rel="noopener">Start now →</a>` : ""}
    `);
    el.classList.add("hero-card");
    stream.appendChild(el);
  }

  // Mirrors My Progress: a named state, then the real rows — clickable, with what's
  // left in each. No score: the student is never shown one there either.
  function addStatus(s) {
    const rows = (s.rows || []).map((r) => {
      const left = r.items.filter((i) => !i.complete);
      const detail = r.done
        ? "done"
        : left.map((i) => (i.url ? `<a href="${i.url}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name))).join(", ");
      return `
        <div class="plan-item">
          <div class="time">${r.done ? "✓" : ""}</div>
          <div>
            <span>Week ${r.week}</span>
            <div class="why">${detail}</div>
          </div>
        </div>`;
    }).join("");
    stream.appendChild(card(`
      <div class="k">Where you stand</div>
      <div class="status-line">${esc(s.label)}</div>
      <div class="meta"><span>${s.doneCount} of ${s.dueCount} weeks finished</span></div>
      ${rows}
    `));
  }

  function addSpecial(s) {
    const support = s.kind === "support";
    const header = support ? "Support" : "Worth knowing";
    const label = support
      ? (s.title || "Reach out")
      : s.kind === "resume" ? "Resume assignment" : "Book a call";
    stream.appendChild(card(`
      <div class="k">${header}</div>
      <div class="next-meta" style="margin-bottom:8px">${esc(s.note || label)}</div>
      ${s.url ? `<a class="start ghost" href="${s.url}" target="_blank" rel="noopener">${esc(label)} →</a>` : ""}
    `));
  }

  function addCelebrate() {
    const el = card(`<div class="celebrate">✨ You finished the course.</div><div class="reason">You did it a little at a time — that's the whole trick.</div>`);
    el.classList.add("celebrate-card");
    stream.appendChild(el);
  }

  // ---- primitives ----
  function card(html) { const d = document.createElement("div"); d.className = "card"; d.innerHTML = html; return d; }
  function addAgent(t) { const d = document.createElement("div"); d.className = "agent-msg"; d.textContent = t; stream.appendChild(d); }
  function addUser(t) { const d = document.createElement("div"); d.className = "user-msg"; d.textContent = t; stream.appendChild(d); scrollEnd(); }
  function addThinking() { const d = document.createElement("div"); d.className = "thinking"; d.innerHTML = `<span></span><span></span><span></span>`; stream.appendChild(d); scrollEnd(); return d; }
  function addError(m) { const d = document.createElement("div"); d.className = "card err"; d.textContent = "⚠ " + m; stream.appendChild(d); }
  function hideIntro() { chipWrap.style.display = "none"; }
  function scrollEnd() { stream.lastChild && stream.lastChild.scrollIntoView({ behavior: "smooth", block: "end" }); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
})();
