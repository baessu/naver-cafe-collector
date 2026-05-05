// Threads profile scraper — content script.
// Lives on window so SPA re-mounts don't reset progress.
(() => {
  if (window.__threadsScraper) return;

  const state = {
    running: false,
    posts: new Map(),                // post_url -> row
    processed: new WeakSet(),        // post containers already harvested
    profileOwner: null,              // @handle of the page we started on
    delay: 1500,
    tickCount: 0,
    timer: null,
  };
  window.__threadsScraper = state;

  // ---------- Selectors ----------
  const SEL = {
    postContainer: 'div[data-pressable-container="true"]',
    postLink: 'a[href*="/post/"]',
    userLink: 'a[href^="/@"]',
    media: 'img, video, source[type^="video"]',
  };
  const PROFILE_RE = /^\/@[^/]+\/?$/;

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Animate the scroll across 250–850 ms with an ease-in-out curve so the
  // velocity profile doesn't look like an instantaneous bot teleport.
  function humanScroll(deltaY) {
    return new Promise((resolve) => {
      const start = window.scrollY;
      const end = start + deltaY;
      const duration = 250 + Math.random() * 600;
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / duration);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        window.scrollTo(0, start + (end - start) * e);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  function absUrl(href) {
    try { return new URL(href, location.origin).href; } catch { return href || ""; }
  }

  function isProfilePage() {
    return PROFILE_RE.test(location.pathname);
  }

  function rememberProfileOwner() {
    if (state.profileOwner) return;
    const m = location.pathname.match(/^\/@([^/]+)/);
    if (m) state.profileOwner = m[1];
  }

  // ---------- Field extraction ----------
  function getPostUrl(post) {
    for (const a of post.querySelectorAll(SEL.postLink)) {
      const href = a.getAttribute("href") || "";
      if (/\/post\/[^/]+/.test(href)) return absUrl(href);
    }
    return "";
  }

  function getUsername(post) {
    const a = post.querySelector(SEL.userLink);
    if (!a) return "";
    const m = (a.getAttribute("href") || "").match(/^\/@([^/?#]+)/);
    return m ? m[1] : "";
  }

  function getPostText(post) {
    return (post.innerText || "").replace(/\s+/g, " ").trim();
  }

  // { has, type } where type is "image" | "video" | "image,video" | "".
  // Avatars are filtered out by alt text + size threshold.
  function detectMedia(post) {
    let hasImage = false;
    let hasVideo = false;
    for (const n of post.querySelectorAll(SEL.media)) {
      if (n.tagName === "VIDEO" || n.tagName === "SOURCE") { hasVideo = true; continue; }
      const alt = (n.getAttribute("alt") || "").toLowerCase();
      if (alt.includes("profile picture") || alt.includes("avatar")) continue;
      const w = n.naturalWidth || n.width || 0;
      const h = n.naturalHeight || n.height || 0;
      if (w >= 150 || h >= 150) hasImage = true;
    }
    const type = hasImage && hasVideo ? "image,video"
      : hasImage ? "image"
      : hasVideo ? "video" : "";
    return { has: hasImage || hasVideo, type };
  }

  // Repost = either a nested [data-pressable-container] inside this post (a
  // quote / embed / repost card) OR a small "리포스트함 / Reposted by" badge
  // sitting as a previous sibling above the post container.
  const REPOST_BADGE_RE = /(리포스트(함|했어요)|Reposted(\s+by)?\b|転載しました)/i;

  function detectNestedRepost(post) {
    const inner = post.querySelector(SEL.postContainer);
    if (!inner || inner === post) return null;
    return getPostUrl(inner) || "";
  }

  function detectBadgeRepost(post) {
    let el = post;
    for (let i = 0; i < 3 && el; i++) {
      const parent = el.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib === el) break;
        const t = (sib.textContent || "").trim();
        if (t && t.length <= 80 && REPOST_BADGE_RE.test(t)) return true;
      }
      el = parent;
    }
    return false;
  }

  // ---------- Date resolution ----------
  // Threads displays relative dates ("1일", "6시간", "어제", "1d", "3h") and
  // absolute ones ("2026-03-09", "3월 9일"). Resolve everything to YYYY-MM-DD
  // anchored on the local clock.
  const DATE_RE = /(\d{4}-\d{2}-\d{2})|(\d+\s*(?:년|개월|달|주|일|시간|분|초))|어제|그저께|(\d+\s?[smhdwMy]\b)|(\d{1,2}\s*월\s*\d{1,2}\s*일)/;

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function shiftDays(now, n) { const d = new Date(now); d.setDate(d.getDate() - n); return d; }
  function shiftMonths(now, n) { const d = new Date(now); d.setMonth(d.getMonth() - n); return d; }
  function shiftYears(now, n) { const d = new Date(now); d.setFullYear(d.getFullYear() - n); return d; }

  function extractDate(raw, now = new Date()) {
    const text = (raw || "").slice(0, 200);
    let m;
    if ((m = text.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if (/어제/.test(text)) return fmtDate(shiftDays(now, 1));
    if (/그저께/.test(text)) return fmtDate(shiftDays(now, 2));
    if (/\d+\s*(?:분|초|시간)/.test(text)) return fmtDate(now);
    if ((m = text.match(/(\d+)\s*일/))) return fmtDate(shiftDays(now, parseInt(m[1], 10)));
    if ((m = text.match(/(\d+)\s*주/))) return fmtDate(shiftDays(now, parseInt(m[1], 10) * 7));
    if ((m = text.match(/(\d+)\s*(?:개월|달)/))) return fmtDate(shiftMonths(now, parseInt(m[1], 10)));
    if ((m = text.match(/(\d+)\s*년/))) return fmtDate(shiftYears(now, parseInt(m[1], 10)));
    if ((m = text.match(/(\d+)\s?(s|m|h|d|w|mo|y)\b/i))) {
      const n = parseInt(m[1], 10);
      const u = m[2];
      if (u === "s" || u === "m" || u === "h") return fmtDate(now);
      if (u === "d") return fmtDate(shiftDays(now, n));
      if (u === "w") return fmtDate(shiftDays(now, n * 7));
      if (u === "M" || u.toLowerCase() === "mo") return fmtDate(shiftMonths(now, n));
      if (u === "y") return fmtDate(shiftYears(now, n));
    }
    if ((m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) {
      const month = parseInt(m[1], 10);
      const day = parseInt(m[2], 10);
      let year = now.getFullYear();
      // Future date with no explicit year → assume previous year.
      if (new Date(year, month - 1, day) > now) year -= 1;
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
    return "";
  }

  // ---------- Text cleaning ----------
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function cleanText(raw, username) {
    let s = (raw || "").trim();
    s = s.replace(/^고정됨\s+/, "");
    if (username) s = s.replace(new RegExp(`^${escapeRegex(username)}(?:\\s|$)`), "").trim();
    // Strip up to and including the first date token to drop the topic /
    // category chrome that sits between username and date (e.g. "AI Threads").
    const m = DATE_RE.exec(s);
    if (m && m.index <= 30) s = s.slice(m.index + m[0].length).trim();
    s = s.replace(
      /\s*(?:인기순\s*활동\s*보기|활동\s*보기|답글\s*\d+\s*개\s*더\s*보기|Show\s+\d+\s*(?:more\s+)?repl\w*|View\s+(?:activity|replies))\s*$/i,
      ""
    );
    s = s.replace(/\s+\d{1,3}\s*\/\s*\d{1,3}(?:\s+[\d.,]+(?:천|만|k|m|K|M)?)*\s*$/, "");
    s = s.replace(/(?:\s+[\d.,]+(?:천|만|k|m|K|M)?){2,}\s*$/, "");
    return s.trim();
  }

  // ---------- Row extraction + harvest ----------
  function extractRow(post) {
    const url = getPostUrl(post);
    if (!url) return null;
    const username = getUsername(post);
    const rawText = getPostText(post);
    const media = detectMedia(post);

    let hasRepost = "N";
    let repostedUrl = "";
    const nestedUrl = detectNestedRepost(post);
    if (nestedUrl !== null) {
      hasRepost = "Y";
      repostedUrl = nestedUrl || url;
    } else if (detectBadgeRepost(post)) {
      hasRepost = "Y";
      repostedUrl = url;
    }

    return {
      username,
      date: extractDate(rawText),
      post_url: url,
      has_media: media.has ? "Y" : "N",
      type_media: media.type,
      has_repost: hasRepost,
      reposted_url: repostedUrl,
      text: cleanText(rawText, username),
    };
  }

  // Drop containers that are nested inside another container — those are
  // "quote post" cards that would otherwise produce phantom rows.
  function topLevelContainers() {
    return Array.from(document.querySelectorAll(SEL.postContainer))
      .filter((el) => !el.parentElement?.closest(SEL.postContainer));
  }

  function harvest() {
    const before = state.posts.size;
    const onProfile = isProfilePage();
    for (const p of topLevelContainers()) {
      if (state.processed.has(p)) continue;
      const row = extractRow(p);
      if (!row) continue;
      state.processed.add(p);
      // On the profile page, drop recommended posts ("You might like" etc.) —
      // keep only the owner's posts plus confirmed reposts.
      if (
        onProfile && state.profileOwner &&
        row.username && row.username !== state.profileOwner &&
        row.has_repost !== "Y"
      ) continue;
      if (!state.posts.has(row.post_url)) state.posts.set(row.post_url, row);
    }
    return state.posts.size - before;
  }

  // ---------- Loop ----------
  async function loop() {
    if (!state.running) return;
    rememberProfileOwner();

    if (document.visibilityState !== "visible") {
      state.timer = setTimeout(loop, 1500 + Math.random() * 1500);
      return;
    }

    harvest();

    // At the bottom of the feed: force a scroll to the absolute bottom and
    // wait long enough for Threads' pagination IntersectionObserver to fire.
    // If scrollHeight didn't grow after the wait, there's nothing more to
    // load — stop the run.
    const docH = document.documentElement.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= docH - 400;
    if (atBottom) {
      window.scrollTo(0, docH);
      await sleep(3000 + Math.random() * 2000);
      if (document.documentElement.scrollHeight <= docH) {
        state.running = false;
        return;
      }
    }

    // Anti-automation pacing.
    state.tickCount += 1;
    if (Math.random() < 0.08) {
      // Small backscroll — humans re-read.
      await humanScroll(-window.innerHeight * (0.15 + Math.random() * 0.25));
      await sleep(600 + Math.random() * 1200);
    }
    await humanScroll(window.innerHeight * (0.6 + Math.random() * 0.5));

    let nextDelay = state.delay + (Math.random() - 0.5) * 600;
    if (state.tickCount % (12 + Math.floor(Math.random() * 7)) === 0) {
      nextDelay += 1500 + Math.random() * 1500;     // reading break
    }
    if (state.tickCount % (25 + Math.floor(Math.random() * 16)) === 0) {
      nextDelay += 5000 + Math.random() * 7000;     // thinking pause
    }
    state.timer = setTimeout(loop, Math.max(400, nextDelay));
  }

  // ---------- CSV export ----------
  const HEADERS = [
    "username", "date", "post_url", "has_media", "type_media",
    "has_repost", "reposted_url", "text",
  ];

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows) {
    const lines = [HEADERS.join(",")];
    for (const r of rows) lines.push(HEADERS.map((h) => csvEscape(r[h])).join(","));
    return "﻿" + lines.join("\n");  // BOM so Excel reads UTF-8 correctly
  }

  function download(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const handle = (location.pathname.match(/^\/@([^/]+)/) || [, "threads"])[1];
    a.href = url;
    a.download = `threads_${handle}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Message bridge ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "START": {
        state.delay = msg.delay ?? state.delay;
        state.tickCount = 0;
        state.running = true;
        rememberProfileOwner();
        harvest();
        clearTimeout(state.timer);
        state.timer = setTimeout(loop, state.delay);
        sendResponse({ ok: true, count: state.posts.size });
        return true;
      }
      case "STOP": {
        state.running = false;
        clearTimeout(state.timer);
        sendResponse({ ok: true, count: state.posts.size });
        return true;
      }
      case "STATUS": {
        const all = Array.from(state.posts.values());
        const preview = all.slice(-5).reverse().map((r) => ({
          username: r.username, text: r.text, has_repost: r.has_repost,
        }));
        sendResponse({ running: state.running, count: all.length, preview });
        return true;
      }
      case "CLEAR": {
        state.posts.clear();
        state.processed = new WeakSet();
        sendResponse({ ok: true, count: 0 });
        return true;
      }
      case "EXPORT": {
        const rows = Array.from(state.posts.values());
        download(rows);
        sendResponse({ ok: true, count: rows.length });
        return true;
      }
    }
  });
})();
