// LinkedIn recent-activity scraper — content script.
// Optimized for low CPU/memory and human-like scroll cadence.
(() => {
  if (window.__linkedinScraper) return;

  const state = {
    running: false,
    posts: new Map(),         // urn -> row (compact: no header field stored)
    seenEls: new WeakSet(),   // post elements already harvested
    expanded: new WeakSet(),  // post elements whose "see more" was clicked
    idleScrolls: 0,
    maxIdle: 5,
    delay: 1800,
    timer: null,
    io: null,
    mo: null,
  };
  window.__linkedinScraper = state;

  // ---------- Selectors ----------
  const SEL = {
    postContainer: [
      'div.feed-shared-update-v2',
      'div.occludable-update',
      '[data-urn^="urn:li:activity:"]',
      '[data-id^="urn:li:activity:"]',
    ].join(','),
    header: '.update-components-header, .update-components-header__text-view',
    actor: '.update-components-actor',
    actorName: '.update-components-actor__name, .update-components-actor__title',
    text: '.update-components-text, .feed-shared-update-v2__description .update-components-text',
    image: '.update-components-image',
    video: '.update-components-linkedin-video, video',
    document: '.update-components-document',
    article: '.update-components-article',
    poll: '.update-components-poll',
    celebration: '.update-components-celebration',
    permalinkAnchor: 'a[href*="urn%3Ali%3Aactivity%3A"], a[href*="urn:li:activity:"]',
    seeMore: 'button.inline-show-more-text__button, button.feed-shared-inline-show-more-text__see-more-less-toggle',
    paginate: 'button.scaffold-finite-scroll__load-button',
  };

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const URN_RE = /urn:li:activity:\d+/;
  const idle = (fn) =>
    (window.requestIdleCallback || ((cb) => setTimeout(cb, 16)))(fn, { timeout: 250 });
  const rng = (lo, hi) => lo + Math.random() * (hi - lo);
  const rint = (lo, hi) => Math.floor(rng(lo, hi));
  const jitter = (ms) => Math.round(ms * rng(0.7, 1.3));
  const normText = (el) => (el && el.textContent || "").replace(/\s+/g, " ").trim();

  function absUrl(href) {
    try { return new URL(href, location.origin).href; } catch { return href || ""; }
  }

  // ---------- Date computation ----------
  // LinkedIn IDs: top 41 bits = ms since UTC epoch (Twitter-Snowflake format).
  function dateFromUrn(urn) {
    try {
      const numStr = urn.split(":").pop();
      if (!/^\d+$/.test(numStr)) return null;
      const ms = Number(BigInt(numStr) >> 22n);
      // Sanity bound: must fall in [2010-01-01, now+1d].
      if (ms < 1262304000000 || ms > Date.now() + 86_400_000) return null;
      return new Date(ms);
    } catch { return null; }
  }

  // Pull the visible time text near the actor: "2h", "3d", "1w", "2mo", "1yr",
  // "Edited • 2h • ", with Korean/Japanese variants.
  function findRelativeTimeText(post) {
    // Standard LinkedIn timestamp lives in `.update-components-actor__sub-description`.
    const candidates = [
      '.update-components-actor__sub-description',
      '.update-components-actor__sub-description-link',
      'time',
    ];
    for (const sel of candidates) {
      const txt = normText(post.querySelector(sel));
      if (txt) return txt;
    }
    return "";
  }

  // Parse "2h", "3d", "1w", "2mo", "5yr", "방금", "5분", "2시간", "3일", "1주",
  // "2개월", "1년", "5m ago", "il y a 3 j" — return ms offset before now.
  function parseRelativeOffsetMs(s) {
    if (!s) return null;
    const t = s.toLowerCase();

    // "now" / "방금" / "just now"
    if (/(?:^|\b)(now|just now|방금|たった今)(?:\b|$)/.test(t)) return 0;

    // English / abbreviated: 2h, 3d, 1w, 2mo, 1yr, 5min, 30s
    let m = t.match(/(\d+)\s*(yr|y|mo|month|months|w|wk|weeks|week|d|day|days|h|hr|hours|hour|min|m|s|sec|seconds)\b/);
    if (m) return toMs(parseInt(m[1], 10), m[2]);

    // Korean: 5초, 5분, 2시간, 3일, 1주, 2개월, 1년
    m = t.match(/(\d+)\s*(초|분|시간|일|주|개월|달|년)/);
    if (m) {
      const map = { "초":"s", "분":"min", "시간":"h", "일":"d", "주":"w", "개월":"mo", "달":"mo", "년":"yr" };
      return toMs(parseInt(m[1], 10), map[m[2]]);
    }

    // Japanese: 5秒, 5分, 2時間, 3日, 1週間, 2ヶ月, 1年
    m = t.match(/(\d+)\s*(秒|分|時間|日|週間|週|ヶ月|か月|年)/);
    if (m) {
      const map = { "秒":"s", "分":"min", "時間":"h", "日":"d", "週間":"w", "週":"w", "ヶ月":"mo", "か月":"mo", "年":"yr" };
      return toMs(parseInt(m[1], 10), map[m[2]]);
    }

    return null;
  }

  function toMs(n, unit) {
    const u = unit.toLowerCase();
    const SEC = 1000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
    if (/^s|sec/.test(u)) return n * SEC;
    if (/^m($|in)/.test(u)) return n * MIN;
    if (/^h/.test(u)) return n * HOUR;
    if (/^d/.test(u)) return n * DAY;
    if (/^w/.test(u)) return n * 7 * DAY;
    if (/^mo|month/.test(u)) return n * 30 * DAY;   // approximate
    if (/^y/.test(u)) return n * 365 * DAY;          // approximate
    return null;
  }

  function fmtDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // Resolve the post's timestamp using URN (ground truth) → relative-text fallback.
  function resolvePostedAt(urn, post) {
    const fromUrn = dateFromUrn(urn);
    if (fromUrn) return { date: fromUrn, source: "urn" };
    const rel = findRelativeTimeText(post);
    const off = parseRelativeOffsetMs(rel);
    if (off != null) return { date: new Date(Date.now() - off), source: "relative" };
    return { date: null, source: "" };
  }

  function findUrn(post) {
    let el = post;
    while (el && el !== document.body) {
      const a = el.getAttribute && (el.getAttribute("data-urn") || el.getAttribute("data-id"));
      const m = a && a.match(URN_RE);
      if (m) return m[0];
      el = el.parentElement;
    }
    const child = post.querySelector('[data-urn*="urn:li:activity:"]');
    if (child) {
      const m = (child.getAttribute("data-urn") || "").match(URN_RE);
      if (m) return m[0];
    }
    const a = post.querySelector(SEL.permalinkAnchor);
    if (a) {
      const decoded = decodeURIComponent(a.getAttribute("href") || "");
      const m = decoded.match(URN_RE);
      if (m) return m[0];
    }
    return "";
  }

  function findPermalink(post, urn) {
    const a = post.querySelector(SEL.permalinkAnchor);
    if (a) {
      const href = absUrl(a.getAttribute("href") || "");
      try { const u = new URL(href); u.search = ""; return u.toString(); }
      catch { return href; }
    }
    return urn ? `https://www.linkedin.com/feed/update/${urn}/` : "";
  }

  function getHeaderText(post) {
    return normText(post.querySelector(SEL.header));
  }

  function detectRepost(headerText) {
    return /\breposted this\b|reposted • |님이 퍼감|리포스트|再投稿|転載/i.test(headerText);
  }

  // Order matters: most specific class wins, "image" is a fallback.
  const MEDIA_PROBES = [
    ["video",       SEL.video],
    ["document",    SEL.document],
    ["poll",        SEL.poll],
    ["celebration", SEL.celebration],
    ["article",     SEL.article],
  ];

  function detectMediaKind(post) {
    for (const [kind, sel] of MEDIA_PROBES) {
      if (post.querySelector(sel)) return kind;
    }
    const imgs = post.querySelectorAll(`${SEL.image} img, .ivm-view-attr__img--centered`);
    for (const img of imgs) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt.includes("profile photo") || alt.includes("avatar")) continue;
      if (w >= 150 || h >= 150) return "image";
    }
    return "";
  }

  // LinkedIn renders the actor name twice (visible + visually-hidden), so we
  // often see token sequences doubled: "Tony Lee Tony Lee" → "Tony Lee".
  function dedupeName(s) {
    const t = (s || "").trim();
    if (!t) return "";
    const tokens = t.split(/\s+/);
    const half = tokens.length / 2;
    if (Number.isInteger(half) && tokens.slice(0, half).join(" ") === tokens.slice(half).join(" ")) {
      return tokens.slice(0, half).join(" ");
    }
    return t;
  }

  function getActor(post) {
    const actors = post.querySelectorAll(SEL.actor);
    const target = actors.length ? actors[actors.length - 1] : null;
    if (!target) return { name: "", url: "", handle: "" };
    const nameEl = target.querySelector(SEL.actorName);
    const linkEl = target.querySelector('a[href*="/in/"], a[href*="/company/"]');
    const name = dedupeName(normText(nameEl));
    const url = linkEl ? absUrl(linkEl.getAttribute("href") || "").split("?")[0] : "";
    const m = url.match(/\/(?:in|company)\/([^/?#]+)/);
    return { name, url, handle: m ? m[1] : "" };
  }

  function getPostText(post) {
    return normText(post.querySelector(SEL.text));
  }

  // ---------- Expansion (deferred — runs on EXPORT, not every tick) ----------
  const MORE_TEXT_RE = /(?:^|\s)(?:…\s*)?(?:more|see more|더\s*보기|もっと見る|更多)\s*$/i;

  function expandSeeMore(post) {
    if (state.expanded.has(post)) return false;
    // Class-targeted buttons first; fall back to label-matched <button>s.
    let candidates = Array.from(post.querySelectorAll(SEL.seeMore));
    if (!candidates.length) {
      candidates = Array.from(post.querySelectorAll("button")).filter((b) =>
        MORE_TEXT_RE.test((b.textContent || b.getAttribute("aria-label") || "").trim())
      );
    }
    let clicked = false;
    for (const b of candidates) {
      if (b.getAttribute("aria-expanded") === "true") continue;
      try { b.click(); clicked = true; } catch {}
    }
    if (clicked) state.expanded.add(post);
    return clicked;
  }

  function clickPaginate() {
    const btn = document.querySelector(SEL.paginate);
    if (btn && !btn.disabled) { try { btn.click(); return true; } catch {} }
    return false;
  }

  // ---------- Harvest ----------
  // Profile owner — derived once per call from the page URL.
  // /in/<handle>/recent-activity/all/  →  "<handle>"
  function getProfileUsername() {
    const m = location.pathname.match(/\/in\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function extractRow(post) {
    const urn = findUrn(post);
    if (!urn) return null;
    const headerText = getHeaderText(post);
    const isRepost = detectRepost(headerText);
    const actor = getActor(post);
    const url = findPermalink(post, urn);
    const mediaKind = detectMediaKind(post);
    const { date: postedAt } = resolvePostedAt(urn, post);
    return {
      // Profile owner from URL — stable across reposts and all activity surfaces.
      username: getProfileUsername(),
      date: postedAt ? fmtDate(postedAt) : "",
      post_url: url,
      has_media: mediaKind ? "Y" : "N",
      type_media: mediaKind,
      has_repost: isRepost ? "Y" : "N",
      reposted_url: isRepost ? url : "",
      text: getPostText(post),
      _urn: urn,
      _author_name: actor.name,
      _el: post,
    };
  }

  function harvestEl(post) {
    const row = extractRow(post);
    if (!row) return false;
    const existing = state.posts.get(row._urn);
    if (!existing || (row.text.length > (existing.text || "").length)) {
      state.posts.set(row._urn, row);
      return !existing;
    }
    return false;
  }

  // Direct fallback sweep — runs every tick alongside the IntersectionObserver
  // so we never miss a post that the observer hasn't fired for yet (e.g. nodes
  // created after the MO's last microtask, or hidden-then-revealed cards).
  function harvestAll() {
    const nodes = document.querySelectorAll(SEL.postContainer);
    let added = 0;
    for (const n of nodes) {
      if (harvestEl(n)) added++;
    }
    return added;
  }

  // ---------- Observers (replace per-tick querySelectorAll on whole DOM) ----------
  function ensureObservers() {
    if (state.io && state.mo) return;
    state.io = new IntersectionObserver((entries) => {
      // Batch all hits in this callback into one idle pass — one RIC per
      // intersection burst, not per node.
      const batch = [];
      for (const e of entries) {
        if (!e.isIntersecting || state.seenEls.has(e.target)) continue;
        state.seenEls.add(e.target);
        batch.push(e.target);
        state.io.unobserve(e.target);
      }
      if (batch.length) idle(() => batch.forEach(harvestEl));
    }, { rootMargin: "300px 0px" });

    const observeNew = () => {
      const nodes = document.querySelectorAll(SEL.postContainer);
      for (const n of nodes) {
        if (state.seenEls.has(n)) continue;
        state.io.observe(n);
      }
    };

    const root = document.querySelector('main') || document.body;
    state.mo = new MutationObserver(() => idle(observeNew));
    state.mo.observe(root, { childList: true, subtree: true });
    observeNew();
  }

  function teardownObservers() {
    if (state.mo) { state.mo.disconnect(); state.mo = null; }
    if (state.io) { state.io.disconnect(); state.io = null; }
  }

  // ---------- Human-like behavior model ----------
  // Humans switch between modes; we sample one each tick by weighted choice.
  //   skim   — short, fast scrolls (gliding past)
  //   read   — small scroll, long dwell (reading a post)
  //   browse — medium scroll, medium dwell (default)
  //   glance — small scroll UP then back down (re-reading)
  //   pause  — barely moves; long dwell (thinking / distracted)
  const MODES = [
    { name: "skim",   weight: 0.30, px: [600, 1100], dwell: [400,  900] },
    { name: "browse", weight: 0.35, px: [320,  640], dwell: [900, 1700] },
    { name: "read",   weight: 0.20, px: [120,  320], dwell: [2200, 4800] },
    { name: "glance", weight: 0.08, px: [-260, -60], dwell: [600, 1300] },
    { name: "pause",  weight: 0.07, px: [0,     40], dwell: [3500, 9000] },
  ];

  function pickMode() {
    const r = Math.random();
    let acc = 0;
    for (const m of MODES) { acc += m.weight; if (r < acc) return m; }
    return MODES[1];
  }

  // Fire a small mousemove burst along a curved path so we generate input
  // entropy (LinkedIn looks for >0 mousemoves during interaction).
  function emitMouseTrail() {
    const n = rint(2, 6); // 2–5 events
    const w = window.innerWidth, h = window.innerHeight;
    let x = rng(0.2 * w, 0.8 * w);
    let y = rng(0.2 * h, 0.8 * h);
    for (let i = 0; i < n; i++) {
      x = Math.max(4, Math.min(w - 4, x + rng(-40, 40)));
      y = Math.max(4, Math.min(h - 4, y + rng(-30, 30)));
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }));
    }
  }

  // Multi-step scroll: humans rarely scroll one big chunk; they wheel 2–4 times.
  async function humanScroll(totalPx) {
    const direction = Math.sign(totalPx) || 1;
    const steps = rint(1, 4); // 1–3 sub-steps
    let left = Math.abs(totalPx);
    for (let i = 0; i < steps; i++) {
      const chunk = i === steps - 1 ? left : Math.round(left * rng(0.3, 0.8));
      left -= chunk;
      const dy = direction * chunk;
      window.scrollBy({ top: dy, behavior: "smooth" });
      document.dispatchEvent(new WheelEvent("wheel", {
        deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true,
      }));
      if (i < steps - 1) await sleep(rng(80, 300));
    }
  }

  // Occasional "break" every ~60–120s of activity, mimicking attention drift.
  let lastBreak = Date.now();
  async function maybeTakeBreak() {
    if (Date.now() - lastBreak < rng(60_000, 120_000)) return false;
    lastBreak = Date.now();
    await sleep(rng(4_000, 12_000));
    return true;
  }

  // Aggressive nudge: try multiple ways to make LinkedIn fetch the next batch.
  async function nudgeForMore() {
    let triggered = false;
    if (clickPaginate()) triggered = true;
    // Hard-scroll to the absolute bottom — bypasses smooth-scroll throttling.
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    document.dispatchEvent(new WheelEvent("wheel", { deltaY: 2000, bubbles: true, cancelable: true }));
    // Some LinkedIn surfaces respond to End key.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", code: "End", bubbles: true }));
    return triggered;
  }

  async function tick() {
    if (!state.running) return;

    if (document.hidden) {
      state.timer = setTimeout(tick, 2000);
      return;
    }

    const beforeY = window.scrollY;
    const beforeCount = state.posts.size;

    const mode = pickMode();
    const dy = Math.round(rng(mode.px[0], mode.px[1]));
    const dwell = Math.round(rng(mode.dwell[0], mode.dwell[1]));

    if (Math.random() < 0.35) emitMouseTrail();
    if (Math.abs(dy) > 0) await humanScroll(dy);
    if (Math.random() < 0.20) emitMouseTrail();

    await sleep(dwell);
    // Commit window for IntersectionObserver + requestIdleCallback.
    await sleep(350);
    // Direct fallback harvest — guarantees we see any post in the DOM,
    // independent of whether the IO has fired for it yet.
    harvestAll();

    await maybeTakeBreak();

    const added = state.posts.size - beforeCount;
    const movedFwd = window.scrollY - beforeY;
    const docH = document.documentElement.scrollHeight;
    const nearBottom = window.innerHeight + window.scrollY >= docH - 600;

    if (added > 0) {
      state.idleScrolls = 0;
    }

    // End-of-feed detection: when we're at the bottom with no new posts, ask
    // LinkedIn for more and watch what happens.
    //
    //   docH grew  + posts grew  → continue (next batch loaded, keep scrolling)
    //   docH grew  + posts same  → lazy render lag; bump idle counter, retry
    //   docH same  + posts same  → genuine end of feed; stop.
    if (added === 0 && nearBottom) {
      await nudgeForMore();
      await sleep(jitter(3000)); // generous wait — LinkedIn fetches can take 1–4s
      harvestAll();

      const docH2 = document.documentElement.scrollHeight;
      const grewPosts = state.posts.size > beforeCount;
      const grewDoc = docH2 > docH + 50;

      if (grewPosts) {
        state.idleScrolls = 0;
      } else if (!grewDoc) {
        state.running = false;
        return;
      } else {
        state.idleScrolls += 1;
      }
    }

    if (state.idleScrolls >= state.maxIdle) {
      state.running = false;
      return;
    }
    state.timer = setTimeout(tick, rng(40, 160));
  }

  // ---------- CSV ----------
  const HEADERS = [
    "username", "date", "post_url",
    "has_media", "type_media",
    "has_repost", "reposted_url",
    "text",
  ];

  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toCsv(rows) {
    const lines = [HEADERS.join(",")];
    for (const r of rows) lines.push(HEADERS.map((h) => csvEscape(r[h])).join(","));
    return "﻿" + lines.join("\n");
  }

  function download(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const handle = getProfileUsername() || "linkedin";
    a.href = url;
    a.download = `linkedin_${handle}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Final sweep: expand all stored posts that are still in DOM, then re-harvest.
  async function finalizeForExport() {
    const rows = Array.from(state.posts.values());
    let didExpand = false;
    for (const r of rows) {
      if (r._el && r._el.isConnected && expandSeeMore(r._el)) didExpand = true;
    }
    if (didExpand) await sleep(350);
    for (const r of rows) {
      if (r._el && r._el.isConnected) harvestEl(r._el);
    }
    // Strip the element ref before export (free memory + avoid serialization issues).
    for (const r of state.posts.values()) delete r._el;
  }

  // ---------- Bridge ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START") {
      state.maxIdle = msg.maxIdle ?? state.maxIdle;
      state.delay = msg.delay ?? state.delay;
      state.idleScrolls = 0;
      state.running = true;
      ensureObservers();
      clearTimeout(state.timer);
      state.timer = setTimeout(tick, jitter(state.delay));
      sendResponse({ ok: true, count: state.posts.size });
      return true;
    }
    if (msg.type === "STOP") {
      state.running = false;
      clearTimeout(state.timer);
      // Free observers so they don't keep firing on a paused session.
      teardownObservers();
      sendResponse({ ok: true, count: state.posts.size });
      return true;
    }
    if (msg.type === "STATUS") {
      const rows = Array.from(state.posts.values());
      const preview = rows.slice(-12).reverse().map((r) => ({
        author: r._author_name || r.username || "",
        text: r.text || "",
        is_repost: r.has_repost === "Y",
        posted_date: r.date || "",
      }));
      sendResponse({ running: state.running, count: rows.length, preview });
      return true;
    }
    if (msg.type === "CLEAR") {
      state.posts.clear();
      teardownObservers();
      sendResponse({ ok: true, count: 0 });
      return true;
    }
    if (msg.type === "EXPORT") {
      // Async: do final expand+harvest, then download.
      finalizeForExport().then(() => {
        const rows = Array.from(state.posts.values());
        download(rows);
      });
      sendResponse({ ok: true, count: state.posts.size });
      return true;
    }
  });
})();
