/* ════════════════════════════════════════════════════════════════════════
   Thank you — front-end. Loads the public graph and renders:
     · a canvas force-graph (people ⇄ projects, super-fans drift to center)
     · a searchable wall of every supporter
     · "where the love landed" project ranking
     · the reciprocal "I'm grateful too" section
   Only dependency: d3 (vendored locally).
   ════════════════════════════════════════════════════════════════════════ */

const KIND_COLOR = { star: "#f0b94a", fork: "#5cb8a4", watch: "#b094df", follow: "#ec7d60", love: "#f0b94a", like: "#f0b94a" };
const KIND_LABEL = { star: "starred", fork: "forked", watch: "watched", follow: "follows me", love: "loved", like: "liked" };
const SUPER = 2; // score >= this == super-fan (kept in sync with config.aggregate.superFanThreshold)

const $ = (s, r = document) => r.querySelector(s);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Swap a broken avatar for a neutral placeholder instead of the browser's broken-image icon.
const AVATAR_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%23241a10'/%3E%3C/svg%3E";
const onImgError = `onerror="this.onerror=null;this.src='${AVATAR_FALLBACK}'"`;
const avatar = (url, size = 120) => (url ? safeUrl(url + (url.includes("?") ? "&" : "?") + "s=" + size) : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Only allow http(s) URLs through to href/src — neutralises javascript:/data: from external data.
const safeUrl = (u) => { try { const url = new URL(u, location.href); return /^https?:$/.test(url.protocol) ? url.href : "#"; } catch { return "#"; } };

// Coloured activity tags (star / fork / watch / follow) — shared by the cloud
// tooltip and the wall hover card so they read identically.
const kindTagsHTML = (kinds) =>
  Object.entries(kinds || {})
    .map(([k, v]) => `<span class="tt-tag k-${esc(k)}">${k === "follow" ? "follows me" : v + " " + esc(k) + (v > 1 ? "s" : "")}</span>`)
    .join("");

const personPopHTML = (p) =>
  `<span class="tt-head"><img src="${esc(avatar(p.avatar, 80))}" alt="" ${onImgError}/>` +
  `<span class="tt-id"><span class="tt-name">${esc(p.name || p.title || p.login)}</span>` +
  `<span class="tt-sub">@${esc(p.login)}</span></span></span>` +
  `<span class="tt-tags">${kindTagsHTML(p.kinds)}</span>`;

// Only let real hex colours into inline styles; fall back to a neutral swatch.
const hexColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(c || "") ? c : "var(--muted)");
// Languages rendered with GitHub's own linguist colours.
const langDotsHTML = (languages, max = 6) =>
  (languages || [])
    .slice(0, max)
    .map((l) => `<span class="lang"><i class="lang-dot" style="background:${hexColor(l.color)}"></i>${esc(l.name)}</span>`)
    .join("");

boot();

async function boot() {
  let g;
  try {
    g = await fetch("data/graph.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  } catch (e) {
    const el = $("#stage-loading");
    if (el) el.textContent = "Couldn't load the gratitude right now — please try again shortly.";
    return;
  }

  hydrateChrome(g);
  countUp(g);
  buildGraph(g);
  buildWall(g);
  buildLanded(g);
  buildReciprocal(g);
  buildPresence(g);
  setupReveals();
  document.body.classList.add("loaded"); // fades the loading indicator
}

/* ── Top bar, footer, hero numbers ─────────────────────────────────────── */
function hydrateChrome(g) {
  const labels = { github: "GitHub" };
  // The "github" chip links to the source of this very page.
  $("#source-chips").innerHTML = g.sources
    .map((s) =>
      s === "github" && g.repoUrl
        ? `<a class="chip chip-link" href="${esc(safeUrl(g.repoUrl))}" target="_blank" rel="noopener" title="This page's source on GitHub">${esc(labels[s])} ↗</a>`
        : `<span class="chip">${esc(labels[s] || s)}</span>`,
    )
    .join("");
  const d = new Date(g.generatedAt);
  $("#updated").textContent = "updated " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  $("#foot-links").innerHTML =
    `<a href="${esc(safeUrl(g.me.url))}" target="_blank" rel="noopener">@${esc(g.me.login)}</a>` +
    (g.repoUrl ? `<span class="sep">·</span><a href="${esc(safeUrl(g.repoUrl))}" target="_blank" rel="noopener">source</a>` : "") +
    `<span class="sep">·</span><a href="data/graph.json" target="_blank" rel="noopener">the public data</a>` +
    `<span class="sep">·</span><a href="https://d3js.org" target="_blank" rel="noopener">built with d3</a>`;
}

function countUp(g) {
  const items = [
    ["#c-supporters", g.stats.supporters],
    ["#c-interactions", g.stats.interactions],
    ["#c-projects", g.stats.projects],
    ["#c-superfans", g.stats.superFans],
  ];
  const run = () => items.forEach(([sel, to]) => animateNumber($(sel), to));
  const hero = $(".hero");
  const io = new IntersectionObserver(
    (es) => es.forEach((e) => { if (e.isIntersecting) { run(); io.disconnect(); } }),
    { threshold: 0.3 },
  );
  io.observe(hero);
}

function animateNumber(el, to) {
  if (!el) return;
  if (reduceMotion) { el.textContent = to.toLocaleString("en-US"); return; }
  const dur = 1400, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(to * eased).toLocaleString("en-US");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ════════════════════════════════════════════════════════════════════════
   The constellation (canvas force-graph)
   ════════════════════════════════════════════════════════════════════════ */
function buildGraph(g) {
  const canvas = $("#graph");
  const ctx = canvas.getContext("2d");
  const tooltipEl = $("#tooltip");
  const stage = $(".stage");

  // ── Build nodes ──────────────────────────────────────────────────────
  // The people are the point — keep me + projects quiet, let the faces carry the picture.
  const meNode = { id: "me", type: "me", title: g.me.name, url: g.me.url, avatar: g.me.avatar, r: 19, score: g.stats.supporters };
  const projById = new Map();
  const maxSup = Math.max(1, ...g.projects.map((p) => p.supporters));
  const projectNodes = g.projects.map((p) => {
    const n = { id: p.id, type: "project", title: p.title, url: p.url, language: p.language,
      languages: p.languages, archived: p.archived,
      reactions: p.reactions, supporters: p.supporters,
      r: 6 + 12 * Math.sqrt(p.supporters / maxSup) };
    projById.set(p.id, n);
    return n;
  });
  const personNodes = g.people.map((p) => ({
    id: p.id, type: "person", login: p.login, title: p.name || p.login, url: p.url,
    avatar: p.avatar, score: p.score, kinds: p.kinds, isFollower: p.isFollower,
    super: p.score >= SUPER, r: p.score >= SUPER ? Math.min(26, 10 + p.score * 2.1) : 4,
  }));

  const nodes = [meNode, ...projectNodes, ...personNodes];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = g.links
    .filter((l) => byId.has(l.source) && byId.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, kind: l.kind, platform: l.platform }));

  // adjacency (for hover highlighting), and per-person kind set (for filtering)
  const neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
  const personKinds = new Map();
  for (const l of links) {
    neighbors.get(l.source).add(l.target);
    neighbors.get(l.target).add(l.source);
    if (!personKinds.has(l.source)) personKinds.set(l.source, new Set());
    personKinds.get(l.source).add(l.kind);
  }

  // ── Avatar image cache (only loaded for me + super-fans) ──────────────
  const imgCache = new Map();
  const loadImg = (url) => {
    if (!url) return null;
    if (imgCache.has(url)) return imgCache.get(url);
    const im = new Image();
    im.src = avatar(url, 120);
    im.onload = () => { im._ready = true; scheduleRender(); };
    imgCache.set(im.src, im);
    imgCache.set(url, im);
    return im;
  };
  loadImg(meNode.avatar);
  for (const n of personNodes) if (n.super) loadImg(n.avatar);

  // ── Sizing / DPR ─────────────────────────────────────────────────────
  let W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    sim.force("x", d3.forceX(W / 2).strength(0.09));
    sim.force("y", d3.forceY(H / 2).strength(0.10));
    meNode.fx = W / 2; meNode.fy = H / 2;
    scheduleRender();
  }

  // ── Simulation ───────────────────────────────────────────────────────
  const sim = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id)
      .distance((l) => (l.target.id === "me" || l.target === "me" ? 118 : 20 + (projById.get(l.target.id)?.r || 10)))
      .strength((l) => (l.kind === "follow" ? 0.06 : 0.16)))
    .force("charge", d3.forceManyBody().strength((d) => (d.type === "me" ? -340 : d.type === "project" ? -120 : -14)).distanceMax(360))
    .force("collide", d3.forceCollide((d) => d.r + (d.type === "person" ? 1.6 : 4)).strength(0.9).iterations(1))
    .alpha(1).alphaDecay(0.0215);

  let transform = d3.zoomIdentity;
  let hover = null, filterKind = "all", superOnly = false;

  // ── Render scheduling (rAF-coalesced) ────────────────────────────────
  let pending = false;
  function scheduleRender() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; render(); }); } }
  sim.on("tick", render);

  function visiblePerson(n) {
    if (n.type !== "person") return true;
    if (superOnly && !n.super) return false;
    if (filterKind !== "all" && !(personKinds.get(n.id)?.has(filterKind))) return false;
    return true;
  }
  function visibleLink(l) {
    if (filterKind !== "all" && l.kind !== filterKind) return false;
    if (superOnly) {
      const s = byId.get(l.source.id || l.source), t = byId.get(l.target.id || l.target);
      if (s?.type === "person" && !s.super) return false;
      if (t?.type === "person" && !t.super) return false;
    }
    return true;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const hi = hover ? neighbors.get(hover.id) : null;

    // links
    ctx.lineWidth = 0.7 / transform.k;
    for (const l of links) {
      if (!visibleLink(l)) continue;
      const isHi = hover && (l.source.id === hover.id || l.target.id === hover.id);
      ctx.globalAlpha = hover ? (isHi ? 0.85 : 0.04) : 0.16;
      ctx.strokeStyle = KIND_COLOR[l.kind] || "#f5ecda";
      if (isHi) ctx.lineWidth = 1.4 / transform.k;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
      if (isHi) ctx.lineWidth = 0.7 / transform.k;
    }
    ctx.globalAlpha = 1;

    // people (draw small first, then super-fans on top)
    for (const n of personNodes) {
      if (!visiblePerson(n)) continue;
      const dim = hover && hover.id !== n.id && !hi.has(n.id);
      if (n.super) drawAvatarNode(n, dim);
      else {
        ctx.globalAlpha = dim ? 0.14 : 0.95;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832);
        ctx.fillStyle = n.isFollower ? "#f3936f" : "#f6dca6";
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // projects — quiet discs; labels only when you reach for them
    for (const n of projectNodes) {
      const dim = hover && hover.id !== n.id && !hi.has(n.id);
      const near = hover && (hover.id === n.id || hi.has(n.id));
      ctx.globalAlpha = dim ? 0.18 : 0.66;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832);
      ctx.fillStyle = "#1f1810"; ctx.fill();
      ctx.lineWidth = 1.1 / transform.k; ctx.strokeStyle = "rgba(247,213,133,0.5)"; ctx.stroke();
      if (near) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = "#f5ecda";
        ctx.font = `600 ${Math.max(10, Math.min(15, n.r * 0.9))}px "Hanken Grotesk", sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(n.title, n.x, n.y + n.r + 9);
      }
    }
    ctx.globalAlpha = 1;

    // me (center)
    drawAvatarNode(meNode, false, true);
  }

  function drawAvatarNode(n, dim, isMe = false) {
    ctx.globalAlpha = dim ? 0.16 : 1;
    const im = imgCache.get(avatar(n.avatar, 120));
    // glow / ring
    if (isMe) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, 6.2832);
      const grd = ctx.createRadialGradient(n.x, n.y, n.r, n.x, n.y, n.r + 10);
      grd.addColorStop(0, "rgba(240,185,74,0.3)"); grd.addColorStop(1, "rgba(240,185,74,0)");
      ctx.fillStyle = grd; ctx.fill();
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832); ctx.closePath(); ctx.clip();
    if (im && im._ready) ctx.drawImage(im, n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
    else { ctx.fillStyle = n.super ? "#3a2c16" : "#2a2014"; ctx.fill(); }
    ctx.restore();
    ctx.lineWidth = (isMe ? 1.6 : n.super ? 2.4 : 1.2) / transform.k;
    ctx.strokeStyle = isMe ? "rgba(240,185,74,0.8)" : n.super ? "rgba(243,196,90,0.95)" : "rgba(245,236,218,0.3)";
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Interaction: hover, zoom, drag ───────────────────────────────────
  function pick(event) {
    const [mx, my] = d3.pointer(event, canvas);
    const [gx, gy] = transform.invert([mx, my]);
    const n = sim.find(gx, gy, 22 / transform.k);
    if (n && !visiblePerson(n)) return null;
    return n || null;
  }

  canvas.addEventListener("mousemove", (event) => {
    const n = pick(event);
    if (n !== hover) { hover = n; scheduleRender(); }
    if (n) {
      showTooltip(n, event);
      canvas.style.cursor = "pointer";
    } else { tooltipEl.hidden = true; canvas.style.cursor = "grab"; }
  });
  canvas.addEventListener("mouseleave", () => { hover = null; tooltipEl.hidden = true; scheduleRender(); });
  canvas.addEventListener("click", (event) => {
    const n = pick(event);
    if (n && n.url) window.open(safeUrl(n.url), "_blank", "noopener");
  });

  function showTooltip(n, event) {
    const rect = stage.getBoundingClientRect();
    const [mx, my] = d3.pointer(event, canvas);
    let html = "";
    if (n.type === "project") {
      const langs = langDotsHTML(n.languages);
      html = `<span class="tt-head"><span class="tt-id"><span class="tt-name">${esc(n.title)}${n.archived ? ` <span class="tt-archived">archived</span>` : ""}</span>
        <span class="tt-sub">${n.supporters} supporter${n.supporters === 1 ? "" : "s"} · ${fmtStars(n.reactions)}★</span></span></span>
        ${langs ? `<span class="tt-langs">${langs}</span>` : ""}`;
    } else if (n.type === "me") {
      html = `<span class="tt-head"><img src="${esc(avatar(n.avatar, 80))}" alt="" ${onImgError}><span class="tt-id">
        <span class="tt-name">${esc(n.title)}</span><span class="tt-sub">that's me — thank you for being here</span></span></span>`;
    } else {
      html = personPopHTML(n);
    }
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    tooltipEl.style.left = mx + "px";
    tooltipEl.style.top = my + "px";
    void rect;
  }

  const zoom = d3.zoom().scaleExtent([0.3, 7]).on("zoom", (e) => { transform = e.transform; scheduleRender(); });
  const drag = d3.drag()
    .subject((event) => {
      const [gx, gy] = transform.invert(d3.pointer(event, canvas));
      const n = sim.find(gx, gy, 22 / transform.k);
      return n && visiblePerson(n) ? n : null;
    })
    .on("start", (event) => { event.sourceEvent.stopPropagation(); if (!event.active) sim.alphaTarget(0.25).restart();
      event.subject.fx = event.subject.x; event.subject.fy = event.subject.y; })
    .on("drag", (event) => {
      const [gx, gy] = transform.invert([event.x, event.y]);
      event.subject.fx = gx; event.subject.fy = gy;
    })
    .on("end", (event) => { if (!event.active) sim.alphaTarget(0); if (event.subject.id !== "me") { event.subject.fx = null; event.subject.fy = null; } });

  d3.select(canvas).call(drag).call(zoom);

  // ── Controls ─────────────────────────────────────────────────────────
  $("#controls").querySelectorAll(".filter").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("#controls").querySelectorAll(".filter").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      filterKind = btn.dataset.kind;
      scheduleRender();
    }),
  );
  $("#superfans-only").addEventListener("change", (e) => { superOnly = e.target.checked; scheduleRender(); });
  $("#reset-view").addEventListener("click", () =>
    d3.select(canvas).transition().duration(reduceMotion ? 0 : 600).call(zoom.transform, d3.zoomIdentity),
  );

  window.addEventListener("resize", resize);
  resize();
  // Give the layout a head start so it opens already settled-ish. Under reduced-motion,
  // settle it fully and freeze — no on-load drift (drag still re-heats on user action).
  for (let i = 0; i < (reduceMotion ? 320 : 90); i++) sim.tick();
  if (reduceMotion) sim.stop();
  scheduleRender();
}

/* ════════════════════════════════════════════════════════════════════════
   Wall of thanks
   ════════════════════════════════════════════════════════════════════════ */
function buildWall(g) {
  const grid = $("#wall-grid");
  const people = [...g.people].sort((a, b) => b.score - a.score || (a.login || "").localeCompare(b.login || ""));
  const STEP = 240;

  // Podium: the top three *amounts* get special circles. Everyone tied at an
  // amount shares that amount's circle (so a tie for 2nd → both get the 2nd ring).
  const topAmounts = [...new Set(people.map((p) => p.score))].sort((a, b) => b - a).slice(0, 3);
  const rankOf = (score) => topAmounts.indexOf(score) + 1; // 1|2|3, or 0 when outside the top three

  // Same hover card as the cloud: avatar, name, @handle, coloured activity tags.
  const card = (p) => {
    const rank = rankOf(p.score);
    return `<a class="face ${p.score >= SUPER ? "super" : ""}${rank ? ` rank-${rank}` : ""}" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener" data-name="${esc((p.name || "") + " " + p.login).toLowerCase()}">
       <img loading="lazy" src="${esc(avatar(p.avatar, 120))}" alt="${esc(p.name || p.login)}" ${onImgError}/>
       ${rank ? `<span class="rank-crown">${rank === 1 ? "★" : rank}</span>` : ""}
       ${p.score >= SUPER ? `<span class="score-badge">${p.score}</span>` : ""}
       <span class="face-card">${personPopHTML(p)}</span>
     </a>`;
  };

  let expanded = false;
  function paint() {
    const shown = expanded ? people.length : Math.min(STEP, people.length);
    grid.innerHTML = people.slice(0, shown).map(card).join("");
    // The graph caps people (maxPeopleInGraph); show the true total, note if capped.
    const total = g.stats.supporters;
    $("#wall-count").textContent =
      total > people.length ? `top ${people.length.toLocaleString()} of ${total.toLocaleString()} people` : `${total.toLocaleString()} people`;
    const more = $("#wall-more");
    more.hidden = people.length <= STEP;
    more.textContent = expanded
      ? "Show less"
      : `Show everyone (${(people.length - shown).toLocaleString()} more)`;
  }
  paint();

  $("#wall-more").addEventListener("click", () => {
    expanded = !expanded;
    paint();
    if (!expanded) $("#wall").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#wall-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { paint(); return; }
    const hits = people.filter((p) => `${p.name || ""} ${p.login}`.toLowerCase().includes(q));
    grid.innerHTML = hits.slice(0, 400).map(card).join("");
    $("#wall-count").textContent = `${hits.length.toLocaleString()} match${hits.length === 1 ? "" : "es"}`;
    $("#wall-more").hidden = true;
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Where the love landed
   ════════════════════════════════════════════════════════════════════════ */
function buildLanded(g) {
  const list = $("#landed-list");
  const moreBtn = $("#landed-archived");
  const all = [...g.projects].sort((a, b) => b.supporters - a.supporters || b.reactions - a.reactions);
  const active = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);
  const max = Math.max(1, ...all.map((p) => p.supporters));

  const row = (p, i) => `
    <li><a class="landed-row ${p.archived ? "is-archived" : ""}" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener" style="--w:${(p.supporters / max) * 100}%">
      <span class="landed-rank">${String(i + 1).padStart(2, "0")}</span>
      <span class="landed-main">
        <span class="l-title">${esc(p.title)}${p.archived ? ` <span class="l-archived">archived</span>` : ""}</span>
        <span class="l-meta">${langDotsHTML(p.languages) || "<span class='l-nolang'>—</span>"}</span>
      </span>
      <span class="landed-figs">
        <span class="lf-people">${p.supporters}</span>
        <span class="lf-label">supporters</span>
        <span class="lf-stars">${fmtStars(p.reactions)}★</span>
      </span>
    </a></li>`;

  let showArchived = false;
  const paint = () => {
    const rows = showArchived ? [...active, ...archived] : active;
    list.innerHTML = rows.map((p, i) => row(p, i)).join("");
    moreBtn.hidden = archived.length === 0;
    moreBtn.textContent = showArchived
      ? "Hide archived"
      : `Show ${archived.length} archived project${archived.length === 1 ? "" : "s"}`;
  };
  paint();
  moreBtn.addEventListener("click", () => { showArchived = !showArchived; paint(); });
}

/* ════════════════════════════════════════════════════════════════════════
   I'm grateful too — the shoulders I stand on
   ════════════════════════════════════════════════════════════════════════ */
const fmtStars = (n) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);

const DEP_CAP = 18;

function depCard(d) {
  const reach = d.degree === 2
    ? `via ${d.usageCount} of my deps`
    : `in ${d.usageCount} of my repo${d.usageCount > 1 ? "s" : ""}`;
  return `<a class="dep-card ${d.gem ? "is-gem" : ""} ${d.active ? "" : "is-inactive"}" href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">
    <img class="dep-avatar" src="${esc(avatar(d.owner.avatar, 80))}" alt="${esc(d.owner.login)}" loading="lazy" ${onImgError}/>
    <span class="dep-body">
      <span class="dep-name">${esc(d.repo)}</span>
      <span class="dep-desc">${d.description ? esc(d.description) : ""}</span>
      <span class="dep-foot">
        <span class="dep-activity ${d.active ? "on" : ""}" title="${d.active ? "active — a commit in the last year" : "dormant — no commit in the last year"}"><i></i>${d.active ? "active" : "dormant"}</span>
        <span class="dep-stars">${fmtStars(d.stars)}★</span>
        <span class="dep-use">${reach}</span>
      </span>
    </span>
  </a>`;
}

function buildReciprocal(g) {
  const deps = g.given?.dependencies || [];
  const direct = deps.filter((d) => d.degree !== 2);
  const second = deps.filter((d) => d.degree === 2);
  const grid = $("#dep-grid");
  const note = $("#dep-note");
  const threshold = (g.gemThreshold || 1000).toLocaleString();

  // Description swaps with the active tab.
  const NOTES = {
    worth: `<b>Worth a star</b> = open source I lean on that's still maintained (a commit in the last year) and under ${threshold}★ — small enough that one star is genuinely felt.`,
    used: `<b>Relied upon</b> = every repository I've used as a dependency in one of my projects. Active ones are listed first, then sorted by how many of my repos use them.`,
    second: `<b>Two hops away</b> = the dependencies of my dependencies. Often not famous themselves, but they quietly power the big frameworks I build on.`,
  };

  // "Worth a star" spans both degrees. Active first, then reach, then smallest.
  const byRank = (a, b) => Number(b.active) - Number(a.active) || b.usageCount - a.usageCount || a.stars - b.stars;
  const views = {
    worth: deps.filter((d) => d.gem).sort(byRank),
    used: direct, // already active-first from the aggregator
    second,
  };
  let mode = views.worth.length ? "worth" : "used";
  let expanded = false;

  const secondTab = $('.dep-tab[data-mode="second"]');
  if (secondTab) secondTab.hidden = second.length === 0;

  const more = $("#dep-more");
  const paint = () => {
    const full = views[mode] || [];
    const list = expanded ? full : full.slice(0, DEP_CAP);
    grid.innerHTML = list.length
      ? list.map(depCard).join("")
      : `<p class="recip-empty">Nothing here yet — run <code>npm run sync</code>.</p>`;
    if (note) note.innerHTML = deps.length ? NOTES[mode] || "" : "";
    more.hidden = full.length <= DEP_CAP;
    more.textContent = expanded ? "Show less" : `Show all ${full.length}`;
    $("#dep-meta").textContent = direct.length
      ? `${views.worth.length} worth a star · ${direct.length} libraries I build on` +
        (second.length ? ` · ${second.length} two hops away` : "")
      : "";
  };

  const syncTab = (active) => $("#dep-tabs").querySelectorAll(".dep-tab").forEach((b) => {
    const on = b === active;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $("#dep-tabs").querySelectorAll(".dep-tab").forEach((btn) => {
    if (btn.dataset.mode === mode) syncTab(btn);
    btn.addEventListener("click", () => {
      syncTab(btn);
      mode = btn.dataset.mode;
      expanded = false;
      paint();
    });
  });
  more.addEventListener("click", () => {
    expanded = !expanded;
    paint();
    if (!expanded) $("#reciprocal").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  paint();

  // The people & work I lean on — one merged list, avatar + name.
  // Ranked by reach (people by GitHub followers, repos by stars); ties are
  // shuffled so we don't favour whoever's early in the alphabet.
  const rankByWeight = (a, b) => b.weight - a.weight || a.rand - b.rand;
  const followed = (g.given?.following || [])
    .map((p) => ({ avatar: p.avatar, name: p.name || p.login, url: p.url, weight: p.followers ?? 0, rand: Math.random() }))
    .sort(rankByWeight);
  const starredWork = (g.given?.starred || [])
    .map((p) => ({ avatar: p.avatar, name: p.title, url: p.url, weight: p.reactions ?? 0, rand: Math.random() }))
    .sort(rankByWeight);
  const mine = [...followed, ...starredWork];
  const mineGrid = $("#recip-mine");
  const mineMore = $("#mine-more");
  const mineChip = (m) =>
    `<a class="recip-person" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener">
      <img src="${esc(avatar(m.avatar, 80))}" alt="" loading="lazy" ${onImgError}><b>${esc(m.name)}</b></a>`;
  let mineOpen = false;
  const paintMine = () => {
    if (!mine.length) { mineGrid.innerHTML = `<p class="recip-empty">A quiet follower of work, not people.</p>`; return; }
    mineGrid.innerHTML = (mineOpen ? mine : mine.slice(0, DEP_CAP)).map(mineChip).join("");
    mineMore.hidden = mine.length <= DEP_CAP;
    mineMore.textContent = mineOpen ? "Show less" : `Show all ${mine.length}`;
  };
  mineMore.addEventListener("click", () => { mineOpen = !mineOpen; paintMine(); });
  paintMine();
}

/* ── Where else to find me — just the profiles ─────────────────────────── */
const prettyUrl = (u) => {
  try { const x = new URL(u); return (x.host + x.pathname).replace(/^www\./, "").replace(/\/$/, ""); }
  catch { return u; }
};

function buildPresence(g) {
  const items = g.presence || [];
  const grid = $("#presence-grid");
  if (!grid) return;
  if (!items.length) { grid.closest("section")?.setAttribute("hidden", ""); return; }
  grid.innerHTML = items
    .map(
      (p) => `<a class="presence-card" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">
        <span class="presence-main">
          <span class="presence-label">${esc(p.label)}</span>
          <span class="presence-handle">${esc(prettyUrl(p.url))}</span>
        </span>
        <span class="presence-arrow">↗</span>
      </a>`,
    )
    .join("");
}

/* ── Scroll reveals ────────────────────────────────────────────────────── */
function setupReveals() {
  const io = new IntersectionObserver(
    (es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
    { threshold: 0.12 },
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
  document.querySelectorAll("section").forEach((s) => { s.classList.add("reveal-section"); io.observe(s); });
  // hero reveals fire immediately
  requestAnimationFrame(() => document.querySelectorAll(".hero .reveal").forEach((el) => el.classList.add("in")));
}
