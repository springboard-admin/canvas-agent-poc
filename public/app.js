// Study Agent SPA — Phase 1: conversational, state-aware, delightful & lite.
// Memory is client-side: we keep the transcript here and resend it each turn.
(function () {
  const boot = window.__BOOT__ || { name: "there", course: "" };
  const root = document.getElementById("root");

  // ---- state ----
  const transcript = []; // {role, content}
  let energy = null;     // "low" | "ok" | "high" | null
  let busy = false;

  root.innerHTML = `
    <div class="hero">
      <div class="orb" id="orb"></div>
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

  // The model chooses the card via data.show. Default is none — the conversation is the
  // product; a card is the exception. Never repeat the same card two turns running.
  let lastCard = null;
  function render(data) {
    if (data.say) addAgent(data.say);
    if (data.celebrate) addCelebrate();

    const show = data.show || "none";
    const sig = show + ":" + (data.status ? data.status.doneCount + "/" + data.status.dueCount : "") + ":" + (data.nextAction ? data.nextAction.title : "");
    const dupe = sig === lastCard;

    if (!dupe && show === "overview" && data.status) addStatus(data.status);
    else if (!dupe && show === "next" && data.nextAction) addNextAction(data.nextAction);
    if (show !== "none") lastCard = sig;

    if (data.special) addSpecial(data.special);
    scrollEnd();
  }

  // ---- renderers ----
  function addNextAction(a) {
    // Show scored/required so the tile says exactly what's needed to clear it.
    let scoreBit = "";
    if (a.score != null && a.outOf) scoreBit = `scored ${a.score}/${a.outOf}${a.needPct ? " · need " + a.needPct + "%" : ""}`;
    else if (a.needPct) scoreBit = `need ${a.needPct}% to pass`;
    const metaBits = [a.week ? "Week " + a.week : "", scoreBit].filter(Boolean).join(" · ");
    const el = card(`
      <div class="k">Your next step</div>
      <div class="next-title">${esc(a.title)}</div>
      <div class="next-meta">${esc(metaBits)}</div>
      ${a.url ? `<a class="start" href="${a.url}" target="_blank" rel="noopener">Start now →</a>` : ""}
    `);
    el.classList.add("hero-card");
    stream.appendChild(el);
  }

  // Mirrors My Progress exactly. Focus view (behind): no score, just the next step.
  // Detailed view (on track): score + the full week list. Rows are whole-row clickable.
  function addStatus(s) {
    // A whole-row link: clicking anywhere opens the row's target in a new tab.
    const row = (week, detailHtml, url, done) => {
      const inner = `
        <div class="time">${done ? "✓" : ""}</div>
        <div>
          <span>Week ${week}</span>
          <div class="why">${detailHtml}</div>
        </div>`;
      return url
        ? `<a class="plan-item rowlink" href="${url}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="plan-item">${inner}</div>`;
    };

    if (s.view === "focus") {
      const n = s.next;
      const body = n
        ? row(n.week, esc(n.title), n.url, false)
        : `<div class="why">You're all caught up for this week.</div>`;
      stream.appendChild(card(`
        <div class="k">Where you stand</div>
        <div class="status-line">${esc(s.label)}</div>
        <div class="meta"><span>Start here — one step at a time</span></div>
        ${body}
      `));
      return;
    }

    // Detailed view — each item shows scored / required so the student sees exactly what's
    // needed to pass. Whole row links to the first outstanding item.
    const pass = s.passPercent || 80;
    const itemLine = (i) => {
      let tail;
      if (i.complete) tail = `${i.score}/${i.outOf} ✓`;
      else if (i.score != null) tail = `${i.score}/${i.outOf} · need ${pass}%`;
      else tail = "not started";
      return `${esc(i.name)} — ${tail}`;
    };
    const rows = (s.rows || []).map((r) => {
      const detail = r.items.map(itemLine).join("<br>");
      const url = (r.items.find((i) => !i.complete && i.url) || r.items.find((i) => i.url) || {}).url || null;
      return row(r.week, detail, url, r.done);
    }).join("");
    const scoreLine =
      typeof s.score === "number"
        ? `<span class="score ${s.scoreBand === "good" ? "good" : "warn"}">${s.score}%</span>`
        : "";
    stream.appendChild(card(`
      <div class="k">Where you stand</div>
      <div class="status-line">${esc(s.label)} ${scoreLine}</div>
      <div class="meta"><span>${gateLine(s)}</span></div>
      ${rows}
    `));
  }

  // Progress phrased by the pass gate — the real "what does done mean" for this course.
  function gateLine(s) {
    const g = s.gate;
    if (g && g.type === "all_complete") return `${g.passedCount} of ${g.totalCount} modules passed`;
    if (g && g.type === "pass_count") return `${g.passedCount} of ${g.required} needed passed`;
    if (g && g.type === "cumulative") return `need ${g.passThreshold}% overall`;
    return `${s.doneCount} of ${s.dueCount} weeks finished`;
  }

  function addSpecial(s) {
    // Advising deflection: show the inbox as copyable text (no mailto — unreliable across
    // browsers/devices) with a one-click Copy button.
    if (s.kind === "advising") {
      const el = card(`
        <div class="k">${esc(s.title || "Your advising team")}</div>
        <div class="next-meta" style="margin-bottom:8px">${esc(s.note || "")}</div>
        <div class="copyrow">
          <span class="copyemail">${esc(s.email)}</span>
          <button class="copybtn" type="button">Copy</button>
        </div>
      `);
      const btn = el.querySelector(".copybtn");
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(s.email); btn.textContent = "Copied"; }
        catch { const r = document.createRange(); r.selectNodeContents(el.querySelector(".copyemail")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = "Select→copy"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
      });
      stream.appendChild(el);
      return;
    }
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
