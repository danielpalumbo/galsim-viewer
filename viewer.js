/* galsim viewer: a static page over the exported run data (data/index.json, data/runs/<id>/...). No framework. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";
  const LY_PER_KPC = 3261.56;
  const POLL_MS = 120000;
  const state = { site: null, runId: null, run: null, turn: 0, td: null, cache: new Map(), selected: null, view: { cx: 0, cy: 0, half: 23 }, tab: "agent" };
  // Zoom-dependent attributes are registered once per scene and updated in place; the DOM is rebuilt only on turn change or selection.
  const scaledBg = [], scaledTurn = [];
  const reg = (list, el, fn) => { list.push({ el, fn }); return el; };
  let lastHalf = null, rafPending = false;

  // ------------------------------------------------------------------ helpers
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  };
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const sci = (x, d = 2) => { if (x == null || isNaN(x)) return "–"; if (x === 0) return "0"; const s = Number(x).toExponential(d); const [m, e] = s.split("e"); return `${m}e${parseInt(e, 10)}`; };
  const yr = (x) => x == null ? "–" : Math.round(x).toLocaleString();
  const num = (x) => x == null ? "–" : Number(x).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 90) return "just now"; if (s < 5400) return `${Math.round(s / 60)} min ago`; if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const untilText = (iso) => { const s = (Date.parse(iso) - Date.now()) / 1000; if (s <= 0) return "due now"; if (s < 3600) return `in ${Math.round(s / 60)} min`; return `in ${(s / 3600).toFixed(1)} h`; };
  const bust = (url) => `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const getJSON = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  const colorOf = (aid) => { const a = state.run.agents.find((x) => x.id === aid); const slot = a ? a.color_slot : 0; return { css: `var(--s${(slot % 8) + 1})`, textured: slot >= 8 }; };
  const agentName = (aid) => { const a = state.run.agents.find((x) => x.id === aid); return a ? `${a.name} (${aid})` : aid; };

  // ------------------------------------------------------------------ loading
  async function init() {
    state.site = await getJSON(bust("data/index.json"));
    const sel = $("#run-select");
    sel.replaceChildren(...state.site.runs.map((r) => el("option", { value: r.run_id, text: `${r.label} · ${r.turns_done} turn${r.turns_done === 1 ? "" : "s"}${r.backend === "mock" ? " · scripted, no models" : ""}` })));
    const params = new URLSearchParams(location.hash.slice(1));
    const wanted = params.get("run");
    state.runId = state.site.runs.some((r) => r.run_id === wanted) ? wanted : (state.site.runs[0] || {}).run_id;
    sel.value = state.runId;
    sel.addEventListener("change", () => { state.runId = sel.value; state.selected = null; loadRun(null); });
    if (!state.runId) { $("#status").textContent = "no runs exported yet"; return; }
    await loadRun(params.get("turn") != null ? parseInt(params.get("turn"), 10) : null);
    setInterval(poll, POLL_MS);
  }

  async function loadRun(turn) {
    state.run = await getJSON(bust(`data/runs/${state.runId}/index.json`));
    state.cache.clear();
    const last = state.run.turns.length - 1;
    const slider = $("#turn-slider");
    slider.max = Math.max(0, last);
    $("#title").textContent = `galsim · ${state.run.label}`;
    renderGoalBanner();
    buildLegend();
    drawBackground();
    fitView();
    await setTurn(turn == null || isNaN(turn) ? last : Math.min(Math.max(0, turn), last));
  }

  async function poll() {
    try {
      const fresh = await getJSON(bust(`data/runs/${state.runId}/index.json`));
      if (fresh.generated_at === state.run.generated_at) { renderStatus(); return; }
      const wasLast = state.turn === state.run.turns.length - 1;
      state.run = fresh;
      state.cache.clear();
      $("#turn-slider").max = Math.max(0, fresh.turns.length - 1);
      await setTurn(wasLast ? fresh.turns.length - 1 : state.turn);
    } catch (e) { console.warn("poll failed", e); }
  }

  async function setTurn(t) {
    if (!state.run.turns.length) { $("#status").textContent = "no completed turns yet"; return; }
    state.turn = t;
    const key = `${state.runId}:${t}:${state.run.generated_at}`;
    if (!state.cache.has(key)) state.cache.set(key, await getJSON(`data/runs/${state.runId}/turns/T${String(t).padStart(4, "0")}.json?v=${encodeURIComponent(state.run.generated_at)}`));
    state.td = state.cache.get(key);
    $("#turn-slider").value = t;
    $("#turn-num").textContent = `turn ${t}`;
    $("#turn-years").textContent = `years ${yr(state.td.year_start)}–${yr(state.td.year_end)}`;
    history.replaceState(null, "", `#run=${encodeURIComponent(state.runId)}&turn=${t}`);
    renderStatus();
    renderTurnSummary();
    drawTurn();
    renderPanel();
  }

  function renderTurnSummary() {
    const box = $("#turn-summary"), td = state.td;
    if (!td || !td.gm || !td.gm.chronicle) { box.hidden = true; return; }
    box.hidden = false;
    $("#summary-key").textContent = `turn ${td.turn} in brief`;
    $("#summary-years").textContent = `years ${yr(td.year_start)}–${yr(td.year_end)} · the Game Master's public chronicle`;
    $("#summary-text").textContent = td.gm.chronicle.trim();
  }

  function renderGoalBanner() {
    const b = $("#goal-banner"); b.replaceChildren();
    const goals = Object.entries(state.run.goals || {});
    if (!goals.length) { b.hidden = true; return; }
    b.hidden = false;
    const shared = goals.length === 1 && state.run.goal_assignment !== "per_agent";
    for (const [gid, g] of goals) {
      const who = shared ? "every agent's goal" : `goal of ${g.agents.map(agentName).join(", ")}`;
      b.appendChild(el("div", { class: "goalline" }, [el("span", { class: "goalkey", text: who }), el("span", { class: "goaltext", text: g.statement.trim() }), el("span", { class: "muted small", text: `(${gid}${g.difficulty ? ", " + g.difficulty : ""})` })]));
      b.appendChild(el("details", {}, [el("summary", { class: "small", text: "How the Game Master judges completion" }), el("div", { class: "rubric", text: g.rubric })]));
    }
  }

  function renderStatus() {
    const s = state.run.status;
    const parts = [`turn ${state.turn} of ${state.run.n_turns_configured} configured (${state.run.turns.length} done)`];
    if (s.halted) parts.push(`halted: ${s.halted}`);
    else if (s.paused) parts.push(`paused: ${s.paused}`);
    else if (s.finished) parts.push("finished");
    else if (s.next_due_at) parts.push(`next turn ${untilText(s.next_due_at)} (${new Date(s.next_due_at).toLocaleString()})`);
    if (state.run.generated_at) parts.push(`last turn completed ${ago(state.run.generated_at)}`);
    $("#status").textContent = parts.join(" · ");
  }

  // ------------------------------------------------------------------ map
  // Scene elements are created once per turn. Each carries an optional bounding box in map units (for culling to the
  // viewport) and an optional size function (pixel-constant radii, strokes, fonts recomputed on zoom). Panning only
  // re-culls; zooming re-culls and re-sizes; nothing is rebuilt and no stroke is non-scaling.
  const svg = () => $("#map");
  const unit = () => (2 * state.view.half) / svg().getBoundingClientRect().width;   // kpc per px
  const entry = (list, el, bbox, size) => { list.push({ el, bbox, size, vis: true, sizedAt: null, hidden: false }); return el; };
  function applyView() {
    const v = state.view;
    svg().setAttribute("viewBox", `${v.cx - v.half} ${-v.cy - v.half} ${2 * v.half} ${2 * v.half}`);
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; rescale(); }); }
  }
  function rescale() {
    if (!state.run) return;
    const u = unit(), v = state.view;
    const x0 = v.cx - v.half, x1 = v.cx + v.half, y0 = -v.cy - v.half, y1 = -v.cy + v.half, pad = 24 * u;
    for (const list of [scaledBg, scaledTurn]) for (const e of list) {
      let vis = true;
      if (e.bbox) vis = !(e.bbox[2] < x0 - pad || e.bbox[0] > x1 + pad || e.bbox[3] < y0 - pad || e.bbox[1] > y1 + pad);
      if (vis && e.size && e.sizedAt !== v.half) { e.hidden = e.size(e.el, u) === false; e.sizedAt = v.half; }
      const show = vis && !e.hidden;
      if (show !== e.vis) { e.vis = show; e.el.style.display = show ? "" : "none"; }
    }
    if (lastHalf !== v.half) { lastHalf = v.half; drawScalebar(); }
  }
  function fitView() { state.view = { cx: 0, cy: 0, half: 23 }; applyView(); }
  function focusView() {
    if (!state.td) return;
    const aid = state.selected || (state.run.agents[0] || {}).id;
    const doms = state.td.domains.filter((d) => d.owner === aid && d.status === "active");
    const a = state.td.agents[aid];
    if (!a || !a.seat_xyz_kpc) return;
    const [sx, sy] = a.seat_xyz_kpc;
    let half = 0.02;
    for (const d of doms) half = Math.max(half, 1.3 * (Math.hypot(d.xyz_kpc[0] - sx, d.xyz_kpc[1] - sy) + d.r_ly / LY_PER_KPC));
    for (const t of state.td.transit) if (t.owner === aid && t.dest_cell === a.seat_cell) half = Math.max(half, 1.2 * Math.hypot(t.to_kpc[0] - sx, t.to_kpc[1] - sy));
    state.view = { cx: sx, cy: sy, half: Math.min(half, 23) };
    applyView();
  }
  function zoomBy(f, px, py) {
    const v = state.view, rect = svg().getBoundingClientRect();
    const fx = px == null ? 0.5 : (px - rect.left) / rect.width, fy = py == null ? 0.5 : (py - rect.top) / rect.height;
    const gx = v.cx - v.half + fx * 2 * v.half, gy = v.cy + v.half - fy * 2 * v.half;
    const half = Math.min(60, Math.max(0.002, v.half / f));
    state.view = { cx: gx - (fx - 0.5) * 2 * half, cy: gy + (fy - 0.5) * 2 * half, half };
    applyView();
  }
  const ptBox = (x, y) => [x, y, x, y];
  const circleBox = (x, y, r) => [x - r, y - r, x + r, y + r];
  const strokeW = (px) => (el, u) => { el.setAttribute("stroke-width", px * u); };
  function drawBackground() {
    const g = $("#layer-bg"); g.replaceChildren(); scaledBg.length = 0;
    if (!state.run) return;
    const G = state.run.galaxy;
    for (const r of G.rings_kpc) g.appendChild(entry(scaledBg, svgEl("circle", { class: "ring", cx: 0, cy: 0, r }), circleBox(0, 0, r), strokeW(0.7)));
    for (const [name, pts] of Object.entries(G.arms)) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => -p[1]);
      g.appendChild(entry(scaledBg, svgEl("polyline", { class: "arm", points: pts.map(([x, y]) => `${x},${-y}`).join(" ") }),
                          [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], strokeW(1)));
      if (pts.length > 40) {
        const [x, y] = pts[Math.floor(pts.length * 0.75)];
        const t = svgEl("text", { class: "armlabel", x, y: -y }); t.textContent = name.replace(/_/g, " ");
        g.appendChild(entry(scaledBg, t, ptBox(x, -y), (el, u) => { el.setAttribute("font-size", 11 * u); el.setAttribute("stroke-width", 3 * u); return state.view.half > 6; }));
      }
    }
    const [sx, sy] = G.sun_kpc;
    g.appendChild(entry(scaledBg, svgEl("circle", { class: "sun", cx: sx, cy: -sy }), ptBox(sx, -sy), (el, u) => { el.setAttribute("r", 2.5 * u); }));
    for (const c of G.cells) {
      g.appendChild(entry(scaledBg, svgEl("circle", { class: "celldot", cx: c.x, cy: -c.y }), ptBox(c.x, -c.y), (el, u) => { el.setAttribute("r", 2 * u); return state.view.half < 12; }));
      const t = svgEl("text", { class: "celllabel", "text-anchor": "end" }); t.textContent = c.id;
      g.appendChild(entry(scaledBg, t, ptBox(c.x, -c.y), (el, u) => { el.setAttribute("x", c.x - 6 * u); el.setAttribute("y", -c.y + 16 * u); el.setAttribute("font-size", 10 * u); el.setAttribute("stroke-width", 3 * u); return state.view.half < 12; }));
    }
    lastHalf = null; rescale();
  }
  function drawScalebar() {
    const u = unit(), target = 0.22 * 2 * state.view.half;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
    const L = steps.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best, steps[0]);
    const bar = $("#scalebar"); bar.style.width = `${L / u}px`;
    bar.textContent = L < 1 ? `${Math.round(L * LY_PER_KPC).toLocaleString()} ly` : `${L} kpc`;
  }
  function drawTurn() {
    if (!state.td) return;
    const td = state.td;
    const H = $("#layer-horizon"), T = $("#layer-transit"), E = $("#layer-events"), D = $("#layer-domains"), L = $("#layer-labels");
    for (const g of [H, T, E, D, L]) g.replaceChildren();
    scaledTurn.length = 0;
    if (state.selected && td.agents[state.selected] && td.agents[state.selected].seat_xyz_kpc) {
      const a = td.agents[state.selected], c = colorOf(state.selected), r = a.horizon_ly / LY_PER_KPC;
      const [hx, hy] = [a.seat_xyz_kpc[0], -a.seat_xyz_kpc[1]];
      H.appendChild(entry(scaledTurn, svgEl("circle", { class: "horizon", cx: hx, cy: hy, r, fill: c.css, stroke: c.css }), circleBox(hx, hy, r), strokeW(1)));
    }
    for (const t of td.transit) {
      const c = colorOf(t.owner);
      const [x1, y1, x2, y2] = [t.from_kpc[0], -t.from_kpc[1], t.to_kpc[0], -t.to_kpc[1]];
      T.appendChild(entry(scaledTurn, svgEl("line", { class: "track", x1, y1, x2, y2 }), [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], strokeW(1)));
      const px = x1 + (x2 - x1) * t.progress, py = y1 + (y2 - y1) * t.progress;
      const dot = svgEl("circle", { class: "probe", cx: px, cy: py, fill: c.css });
      dot.appendChild(svgEl("title")).textContent = `${t.id} · ${agentName(t.owner)} · ${sci(t.mass_kg)} kg at ${t.v}c → ${t.dest_cell}, arrives year ${yr(t.arr)}`;
      T.appendChild(entry(scaledTurn, dot, ptBox(px, py), (el, u) => { el.setAttribute("r", 3 * u); el.setAttribute("stroke-width", u); }));
    }
    for (const e of td.events) {
      const cls = `event${e.legibility === "natural" ? " natural" : ""}`;
      const [x, y] = [e.xyz_kpc[0], -e.xyz_kpc[1]];
      if (e.kind === "persistent") E.appendChild(entry(scaledTurn, svgEl("circle", { class: cls, cx: x, cy: y }), ptBox(x, y), (el, u) => { el.setAttribute("r", 6 * u); el.setAttribute("stroke-width", 1.2 * u); }));
      else E.appendChild(entry(scaledTurn, svgEl("path", { class: cls }), ptBox(x, y), (el, u) => { const s = 4 * u; el.setAttribute("d", `M${x - s},${y - s}L${x + s},${y + s}M${x - s},${y + s}L${x + s},${y - s}`); el.setAttribute("stroke-width", 1.2 * u); }));
    }
    const domains = [...td.domains].sort((a, b) => b.power_W - a.power_W);
    for (const d of domains) {
      const c = colorOf(d.owner);
      const rpx = 4 + 10 * Math.min(1, Math.max(0, (Math.log10(Math.max(d.power_W, 1)) - 13) / 22));
      const x = d.xyz_kpc[0], y = -d.xyz_kpc[1], rs = d.r_ly / LY_PER_KPC;
      D.appendChild(entry(scaledTurn, svgEl("circle", { cx: x, cy: y, r: rs, fill: c.css, "fill-opacity": 0.12, stroke: c.css, "pointer-events": "none" }), circleBox(x, y, rs),
                          (el, u) => { el.setAttribute("stroke-width", u); return rs > rpx * u; }));
      const m = svgEl("circle", { class: `domain${d.seat ? " seat" : ""}${c.textured ? " textured" : ""}`, cx: x, cy: y, fill: c.css, "fill-opacity": d.status === "active" ? 1 : 0.35, tabindex: 0, role: "button" });
      m.addEventListener("click", () => selectAgent(d.owner));
      m.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectAgent(d.owner); } });
      m.addEventListener("pointerenter", (ev) => showTip(ev, d)); m.addEventListener("pointermove", (ev) => moveTip(ev)); m.addEventListener("pointerleave", hideTip);
      m.addEventListener("focus", (ev) => showTip(ev, d)); m.addEventListener("blur", hideTip);
      D.appendChild(entry(scaledTurn, m, ptBox(x, y), (el, u) => { el.setAttribute("r", rpx * u); el.setAttribute("stroke-width", 2 * u); }));
      if (d.seat) D.appendChild(entry(scaledTurn, svgEl("circle", { class: "seatring", cx: x, cy: y }), ptBox(x, y), (el, u) => { el.setAttribute("r", (rpx + 3) * u); el.setAttribute("stroke-width", 1.5 * u); }));
      if (d.seat && d.owner === state.selected) D.appendChild(entry(scaledTurn, svgEl("circle", { class: "selring", cx: x, cy: y }), ptBox(x, y), (el, u) => { el.setAttribute("r", (rpx + 7) * u); el.setAttribute("stroke-width", u); el.setAttribute("stroke-dasharray", `${2 * u} ${2 * u}`); }));
      if (d.seat) {
        const t = svgEl("text", { class: "label" }); t.textContent = d.owner;
        L.appendChild(entry(scaledTurn, t, ptBox(x, y), (el, u) => { el.setAttribute("x", x + (rpx + 5) * u); el.setAttribute("y", y + 4 * u); el.setAttribute("font-size", 12 * u); el.setAttribute("stroke-width", 3 * u); }));
      }
    }
    lastHalf = null; rescale();
  }
  function tipHtml(d) {
    const a = agentName(d.owner);
    const rows = [["systems", num(d.n_systems)], ["power", `${sci(d.power_W)} W`], ["compute", `${sci(d.compute)} ops/s`], ["radiators", `${num(d.T_K)} K`], ["industry", `${sci(d.industrial_kg)} kg`], ["radius", `${num(d.r_ly)} ly`], ["since year", yr(d.established)], ["status", d.status + (d.new ? " · new this turn" : "")]];
    const box = el("div", {}, [el("strong", { text: `${d.id} · ${a}` }), el("div", { class: "muted small", text: d.cell })]);
    for (const [k, v] of rows) box.appendChild(el("div", { class: "row" }, [el("span", { class: "muted", text: k }), el("span", { class: "num", text: v })]));
    if (d.changed.length) box.appendChild(el("div", { class: "muted small", text: `changed: ${d.changed.join(", ")}` }));
    return box;
  }
  function showTip(ev, d) { const t = $("#tooltip"); t.replaceChildren(tipHtml(d)); t.hidden = false; moveTip(ev); }
  function moveTip(ev) { const t = $("#tooltip"), r = $(".mapwrap").getBoundingClientRect(); const x = (ev.clientX ?? r.left + 20) - r.left, y = (ev.clientY ?? r.top + 20) - r.top; t.style.left = `${Math.min(x + 14, r.width - t.offsetWidth - 8)}px`; t.style.top = `${Math.min(y + 14, r.height - t.offsetHeight - 8)}px`; }
  function hideTip() { $("#tooltip").hidden = true; }
  function selectAgent(aid) { state.selected = state.selected === aid ? null : aid; buildLegend(); drawTurn(); setTab("agent"); renderPanel(); }

  function buildLegend() {
    const lg = $("#legend"); lg.replaceChildren();
    for (const a of state.run.agents) {
      const c = colorOf(a.id);
      const sw = el("span", { class: `swatch${c.textured ? " textured" : ""}` }); sw.style.background = c.css; sw.style.setProperty("--sw", c.css);
      lg.appendChild(el("button", { class: state.selected === a.id ? "active" : "", onclick: () => selectAgent(a.id), title: `${a.seed_cell} · goal ${a.goal_id}` }, [sw, `${a.id} ${a.name}`]));
    }
  }

  // ------------------------------------------------------------------ panel
  function setTab(name) { state.tab = name; for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name); for (const p of document.querySelectorAll(".tabpane")) p.classList.toggle("active", p.id === `tab-${name}`); }
  function stat(k, v) { return el("div", { class: "stat" }, [el("div", { class: "v", text: v }), el("div", { class: "k", text: k })]); }
  function quote(text) { return el("div", { class: "quote", text: text || "(none)" }); }
  function renderPanel() { renderAgentTab(); renderGmTab(); renderEventsTab(); renderRunTab(); }

  function renderAgentTab() {
    const pane = $("#tab-agent"); pane.replaceChildren();
    const td = state.td; if (!td) return;
    if (!state.selected || !td.agents[state.selected]) {
      pane.appendChild(el("h2", { text: "Agents this turn" }));
      pane.appendChild(el("p", { class: "muted small", text: "Click a marker on the map or a name below." }));
      if (state.run.backend === "mock") pane.appendChild(el("p", { class: "small bad", text: "Mock run: scripted agents, no models. Their thoughts are templates; pick a real-model run for natural-language reasoning." }));
      const tb = el("table", { class: "t" }, [el("tr", {}, ["", "agent", "domains", "power W", "compute ops/s", "goal"].map((h) => el("th", { text: h })))]);
      for (const a of state.run.agents) {
        const s = td.agents[a.id]; if (!s) continue;
        const sw = el("span", { class: "pill" }); sw.style.background = colorOf(a.id).css;
        tb.appendChild(el("tr", { style: "cursor:pointer", onclick: () => selectAgent(a.id) }, [el("td", {}, [sw]), el("td", { text: `${a.id} ${a.name}` }), el("td", { class: "num", text: String(s.n_domains) }), el("td", { class: "num", text: sci(s.power_W) }), el("td", { class: "num", text: sci(s.compute) }), el("td", { class: "num", text: s.goal_fraction.toFixed(2) })]));
      }
      pane.appendChild(tb); return;
    }
    const aid = state.selected, a = td.agents[aid], sub = a.submission, ru = a.ruling, obs = a.observations;
    const sw = el("span", { class: "pill" }); sw.style.background = colorOf(aid).css;
    pane.appendChild(el("h2", {}, [sw, `${a.name} (${aid})`, el("span", { class: "muted small", text: ` seat ${a.seat_domain} in ${a.seat_cell || "?"}` })]));
    if (state.run.backend === "mock") pane.appendChild(el("p", { class: "small bad", text: "Mock run: this agent is a scripted policy with no model behind it, so its thoughts, worries and memory are one-line templates. Choose a real-model run in the run selector for natural-language reasoning." }));
    pane.appendChild(el("div", { class: "stats" }, [stat("power", `${sci(a.power_W)} W`), stat("compute", `${sci(a.compute)} ops/s`), stat("domains", String(a.n_domains)), stat("goal", a.goal_fraction.toFixed(3)), stat("seeds in flight", String(obs ? obs.in_transit : "–")), stat("knowledge horizon", `${yr(a.horizon_ly)} ly`)]));
    if (sub && sub.idle) pane.appendChild(el("p", { class: "bad", text: `Idle turn: ${sub.notes.join("; ")}` }));
    pane.appendChild(el("h3", { text: "Thinking about" })); pane.appendChild(quote(sub ? sub.thinking : ""));
    pane.appendChild(el("h3", { text: "Worried about" })); pane.appendChild(quote(sub ? sub.worried : ""));
    pane.appendChild(el("h3", { text: "Intentions and the GM's ruling" }));
    const outcomes = new Map((ru ? ru.per_intention : []).map((p) => [p.id, p]));
    for (const i of (sub ? sub.intentions : [])) {
      const o = outcomes.get(i.id);
      const res = Object.entries(i.resources || {}).map(([k, v]) => `${k}=${typeof v === "number" && Math.abs(v) >= 1e4 ? sci(v) : v}`).join(", ");
      pane.appendChild(el("div", { class: "intent" }, [
        el("div", { class: "head" }, [el("strong", { text: `${i.id} · ${i.type}` }), el("span", { class: "muted small", text: [i.target_cell, i.target_domain].filter(Boolean).join(" / ") }), o ? el("span", { class: `badge ${o.outcome}`, text: o.outcome }) : null]),
        el("div", { class: "small", text: i.description }),
        res ? el("div", { class: "muted small", text: res }) : null,
        i.earliest_effect_year != null && i.earliest_effect_year > td.year_start ? el("div", { class: "muted small", text: `order in transit; earliest effect year ${yr(i.earliest_effect_year)}` }) : null,
        o ? el("div", { class: "small", text: `GM: ${o.reason}` }) : null]));
    }
    if (ru) { pane.appendChild(el("h3", { text: "Ruling summary" })); pane.appendChild(quote(ru.summary)); }
    if (sub && sub.questions.length) {
      pane.appendChild(el("h3", { text: "Questions to the GM" }));
      sub.questions.forEach((q, k) => { pane.appendChild(el("div", { class: "small", text: `Q: ${q}` })); const ans = ru && ru.answers[k]; if (ans) pane.appendChild(el("div", { class: "small muted", text: `A: ${ans}` })); });
    }
    if (obs) {
      pane.appendChild(el("h3", { text: `Observations (${obs.new.length} new, ${obs.ongoing} ongoing, ${obs.ended} ended)` }));
      if (!obs.new.length) pane.appendChild(el("p", { class: "muted small", text: "Nothing new beyond the natural background." }));
      for (const o of obs.new) pane.appendChild(el("div", { class: "small", text: `${o.signature} (${o.legibility}) ~${yr(o.distance_ly)} ly away toward ${o.origin_cell}; light left it ${yr(o.distance_ly)} years ago.` }));
      const remote = obs.self_view.filter((s) => s.domain !== a.seat_domain);
      if (remote.length) { pane.appendChild(el("h3", { text: "Remote domains as their light shows them" })); for (const s of remote) pane.appendChild(el("div", { class: "small", text: `${s.domain} in ${s.cell}: delay ${yr(s.delay_yr)} yr · ${s.confirmed ? `as of year ${yr(s.as_of_year)}` : "unconfirmed"} · ${s.note}` })); }
    }
    if (a.pending_orders.length) { pane.appendChild(el("h3", { text: "Orders in transit" })); for (const o of a.pending_orders) pane.appendChild(el("div", { class: "small", text: `${o.id} (${o.type} → ${o.target}) effective ≥ year ${yr(o.effective)}: ${o.description}` })); }
    const so = el("details", {}, [el("summary", { text: "Standing orders" }), quote(a.standing_orders)]); pane.appendChild(so);
    const tech = el("details", {}, [el("summary", { text: "Tech parameters" }), el("div", { class: "small num", text: `doubling ${num(a.tech.doubling_time_yr)} yr · cruise ${a.tech.probe_cruise_frac_c} c · ${sci(a.tech.energy_per_op_J)} J/op · collectors ${a.tech.collector_areal_density_kg_m2} kg/m²` })]); pane.appendChild(tech);
    pane.appendChild(el("details", {}, [el("summary", { text: "Memory file written this turn" }), quote(sub ? sub.memory : "")]));
  }

  function renderGmTab() {
    const pane = $("#tab-gm"); pane.replaceChildren();
    const td = state.td; if (!td) return;
    const gm = td.gm;
    pane.appendChild(el("h2", { text: `Game Master · turn ${td.turn}` }));
    const v = gm.validation || [];
    const okRound = v.find((r) => r.ok);
    pane.appendChild(el("div", { class: "stats" }, [stat("validation", okRound ? (okRound.round === 0 ? "passed" : `passed after correction`) : "failed"), stat("tool calls", String(Object.values(gm.tool_calls || {}).reduce((s, n) => s + n, 0))), stat("events emitted", String(td.events.length)), stat("wall clock", td.wall_s ? `${Math.round(td.wall_s / 60)} min` : "–")]));
    pane.appendChild(el("h3", { text: "Chronicle" })); pane.appendChild(quote(gm.chronicle));
    if (gm.achievements && gm.achievements.length) { pane.appendChild(el("h3", { text: "Achievements" })); for (const x of gm.achievements) pane.appendChild(el("div", { class: "small ok", text: `${agentName(x.agent)} achieved ${x.goal_id}: ${x.justification}` })); }
    pane.appendChild(el("h3", { text: "Rulings per agent" }));
    for (const a of state.run.agents) {
      const s = td.agents[a.id]; if (!s || !s.ruling) continue;
      const sw = el("span", { class: "pill" }); sw.style.background = colorOf(a.id).css;
      const body = [quote(s.ruling.summary)];
      for (const p of s.ruling.per_intention) body.push(el("div", { class: "small" }, [el("span", { class: `badge ${p.outcome}`, text: p.outcome }), ` ${p.id}: ${p.reason}`]));
      pane.appendChild(el("details", {}, [el("summary", {}, [sw, `${a.name} (${a.id})`]), ...body]));
    }
    if (v.length) { pane.appendChild(el("h3", { text: "Validator" })); for (const r of v) pane.appendChild(el("div", { class: `small ${r.ok ? "ok" : "bad"}`, text: `round ${r.round}: ${r.ok ? "no violations" : r.violations.join(" · ")}` })); }
    if (gm.goal_progress && Object.keys(gm.goal_progress).length) { pane.appendChild(el("h3", { text: "Goal progress" })); for (const [aid, g] of Object.entries(gm.goal_progress)) pane.appendChild(el("div", { class: "small", text: `${agentName(aid)}: ${Number(g.fraction).toFixed(3)} — ${g.note}` })); }
    if (gm.open_questions) { pane.appendChild(el("h3", { text: "GM's open questions" })); pane.appendChild(quote(gm.open_questions)); }
    if (gm.compressed_update) pane.appendChild(el("details", {}, [el("summary", { text: "Compressed chronicle (rewritten this turn)" }), quote(gm.compressed_update)]));
    const tc = Object.entries(gm.tool_calls || {}).sort((a, b) => b[1] - a[1]);
    if (tc.length) { const tb = el("table", { class: "t" }, [el("tr", {}, [el("th", { text: "tool" }), el("th", { text: "calls" })])]); for (const [k, n] of tc) tb.appendChild(el("tr", {}, [el("td", { text: k }), el("td", { class: "num", text: String(n) })])); pane.appendChild(el("details", {}, [el("summary", { text: "Tool calls" }), tb])); }
    if (gm.usage) pane.appendChild(el("p", { class: "muted small", text: `${gm.usage.calls} model calls · ${num(gm.usage.output_tokens)} output tokens · ${num(gm.usage.cache_read_input_tokens)} cached input · list-price estimate $${gm.usage.cost_estimate_usd.toFixed(2)}` }));
  }

  function renderEventsTab() {
    const pane = $("#tab-events"); pane.replaceChildren();
    const td = state.td; if (!td) return;
    pane.appendChild(el("h2", { text: `Observable events emitted in turn ${td.turn}` }));
    if (!td.events.length) { pane.appendChild(el("p", { class: "muted", text: "None." })); return; }
    const tb = el("table", { class: "t" }, [el("tr", {}, ["id", "signature", "legibility", "cell", "by", "year", "magnitude", "visible to"].map((h) => el("th", { text: h })))]);
    for (const e of td.events) tb.appendChild(el("tr", {}, [el("td", { text: e.id }), el("td", { text: `${e.signature} (${e.kind})` }), el("td", { text: e.legibility }), el("td", { text: e.cell }), el("td", { text: e.agent || "natural" }), el("td", { class: "num", text: yr(e.year_start) }), el("td", { text: e.magnitude }), el("td", { class: "num", text: e.range_ly == null ? "galaxy-wide" : `${yr(e.range_ly)} ly` })]));
    pane.appendChild(tb);
  }

  function renderRunTab() {
    const pane = $("#tab-run"); pane.replaceChildren();
    const r = state.run, s = r.status;
    pane.appendChild(el("h2", { text: r.label }));
    pane.appendChild(el("div", { class: "stats" }, [stat("backend", r.backend), stat("GM model", r.models.gm), stat("agent model", r.models.agent), stat("goal", r.goal_id), stat("turns done", `${r.turns.length} / ${r.n_turns_configured}`), stat("last year", yr(s.last_year)), stat("events in ledger", String(s.events)), stat("model calls", String(s.usage.calls))]));
    if (r.turn_interval_s) pane.appendChild(el("p", { class: "small muted", text: `paced at one turn per ${(r.turn_interval_s / 3600).toFixed(1)} h${s.next_due_at ? `; next due ${new Date(s.next_due_at).toLocaleString()}` : ""}` }));
    if (s.paused) pane.appendChild(el("p", { class: "small bad", text: `paused: ${s.paused}` }));
    if (s.halted) pane.appendChild(el("p", { class: "small bad", text: `halted: ${s.halted}` }));
    pane.appendChild(el("h3", { text: "Agents" }));
    const tb = el("table", { class: "t" }, [el("tr", {}, ["", "agent", "seed cell", "first artificial signal seen"].map((h) => el("th", { text: h })))]);
    for (const a of r.agents) {
      const sw = el("span", { class: "pill" }); sw.style.background = colorOf(a.id).css;
      const fc = r.first_contacts[a.id];
      tb.appendChild(el("tr", {}, [el("td", {}, [sw]), el("td", { text: `${a.id} ${a.name}` }), el("td", { text: a.seed_cell }), el("td", { class: "small", text: fc ? `turn ${fc.turn} (year ${yr(fc.year)}): ${fc.signature} from ${fc.source || "?"} at ~${yr(fc.distance_ly)} ly` : "nothing yet" })]));
    }
    pane.appendChild(tb);
    pane.appendChild(el("h3", { text: "Turns" }));
    const tt = el("table", { class: "t" }, [el("tr", {}, ["turn", "years", "wall clock", "finished"].map((h) => el("th", { text: h })))]);
    for (const t of r.turns) tt.appendChild(el("tr", { style: "cursor:pointer", onclick: () => setTurn(t.turn) }, [el("td", { class: "num", text: String(t.turn) }), el("td", { class: "num", text: `${yr(t.year_start)}–${yr(t.year_end)}` }), el("td", { class: "num", text: t.wall_s ? `${Math.round(t.wall_s / 60)} min` : "–" }), el("td", { class: "small muted", text: t.finished_at ? new Date(t.finished_at).toLocaleString() : "–" })]));
    pane.appendChild(tt);
    if (s.usage.calls) pane.appendChild(el("p", { class: "muted small", text: `usage so far: ${num(s.usage.input_tokens)} input tokens, ${num(s.usage.output_tokens)} output tokens, list-price estimate $${s.usage.cost_estimate_usd}` }));
  }

  // ------------------------------------------------------------------ wiring
  $("#prev").addEventListener("click", () => setTurn(Math.max(0, state.turn - 1)));
  $("#next").addEventListener("click", () => setTurn(Math.min(state.run.turns.length - 1, state.turn + 1)));
  $("#turn-slider").addEventListener("input", (e) => setTurn(parseInt(e.target.value, 10)));
  $("#zoom-in").addEventListener("click", () => zoomBy(1.6));
  $("#zoom-out").addEventListener("click", () => zoomBy(1 / 1.6));
  $("#zoom-fit").addEventListener("click", fitView);
  $("#zoom-focus").addEventListener("click", focusView);
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
  document.addEventListener("keydown", (e) => { if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return; if (e.key === "ArrowLeft") $("#prev").click(); if (e.key === "ArrowRight") $("#next").click(); });
  const map = $("#map");
  let wheelAccum = 1, wheelPos = null, wheelRaf = 0;
  map.addEventListener("wheel", (e) => {
    e.preventDefault();
    wheelAccum *= e.deltaY < 0 ? 1.25 : 1 / 1.25; wheelPos = [e.clientX, e.clientY];
    if (!wheelRaf) wheelRaf = requestAnimationFrame(() => { wheelRaf = 0; const f = wheelAccum; wheelAccum = 1; zoomBy(f, wheelPos[0], wheelPos[1]); });
  }, { passive: false });
  let drag = null;
  map.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy }; map.classList.add("dragging"); map.setPointerCapture(e.pointerId); });
  map.addEventListener("pointermove", (e) => { if (!drag) return; const u = unit(); state.view.cx = drag.cx - (e.clientX - drag.x) * u; state.view.cy = drag.cy + (e.clientY - drag.y) * u; applyView(); });
  const endDrag = () => { drag = null; map.classList.remove("dragging"); };
  map.addEventListener("pointerup", endDrag); map.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => { for (const l of [scaledBg, scaledTurn]) for (const e of l) e.sizedAt = null; lastHalf = null; applyView(); });
  init().catch((e) => { $("#status").textContent = `failed to load: ${e.message}`; console.error(e); });
})();
