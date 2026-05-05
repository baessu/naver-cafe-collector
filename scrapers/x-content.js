// X (Twitter) profile scraper — content script.
(() => {
  if (window.__xScraper) return;

  const state = {
    running: false,
    posts: new Map(), // key: post URL -> row
    postsCap: 10000,  // soft cap; oldest entries evicted when exceeded
    recent: [],       // rolling tail (length <= recentCap) for popup preview
    recentCap: 30,
    idleScrolls: 0,
    permalinkIdle: 0,
    bottomIdle: 0,         // ticks at page bottom with no new content
    maxIdle: 10,
    maxBottomIdle: 4,      // 4 ticks (~6-9s w/ jitter) of no growth at bottom
    maxPermalinkIdle: 4,
    lastScrollHeight: 0,
    lastCaptureCount: 0,
    delay: 1500,                  // base; actual delay is jittered
    timer: null,
    captures: [],
    captureCap: 200,              // capped by item count AND by body bytes (below)
    captureBytes: 0,
    captureBytesCap: 8 * 1024 * 1024,
    parseCursor: 0,               // index of next un-parsed capture
    visited: new Set(),
    profileScrollY: 0,
    profileOwner: null,
    actionCount: 0,               // for periodic reading pauses
    nextReadingPauseAt: 30 + Math.floor(Math.random() * 20),
  };
  window.__xScraper = state;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "XS_SCRAPER_CAPTURE") return;
    while (state.captures.length >= state.captureCap) {
      const dropped = state.captures.shift();
      state.captureBytes -= (dropped?.body?.length || 0);
      if (state.parseCursor > 0) state.parseCursor--;
    }
    const bodyLen = (data.body || "").length;
    state.captures.push({
      kind: data.kind, url: data.url, method: data.method,
      status: data.status, contentType: data.contentType,
      body: data.body, truncated: data.truncated, ts: data.ts,
      parsed: false,
    });
    state.captureBytes += bodyLen;
    // Trim oldest bodies until under cap (keep envelope, drop body string).
    let i = 0;
    while (state.captureBytes > state.captureBytesCap && i < state.captures.length) {
      const c = state.captures[i++];
      if (c.parsed && c.body) { state.captureBytes -= c.body.length; c.body = ""; }
    }
  });

  // ---------- Selectors ----------
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    statusLink: 'a[href*="/status/"]',
    socialContext: '[data-testid="socialContext"]',
    tweetText: '[data-testid="tweetText"]',
    photo: '[data-testid="tweetPhoto"]',
    video: 'video, [data-testid="videoPlayer"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const absUrl = (h) => { try { return new URL(h, location.origin).href; } catch { return h || ""; } };
  const rand = (min, max) => min + Math.random() * (max - min);
  const postUrl = (handle, id) => `https://x.com/${handle}/status/${id}`;

  // Jittered delay so loop spacing is never perfectly periodic.
  function jitteredDelay() {
    const base = state.delay;
    return Math.round(base * rand(0.75, 1.4));
  }

  // Track a virtual cursor that drifts within the viewport, so wheel +
  // mouse events carry believable, varying coordinates instead of a fixed
  // center point.
  const cursor = { x: window.innerWidth * 0.4, y: window.innerHeight * 0.4 };
  function driftCursor() {
    const w = window.innerWidth, h = window.innerHeight;
    cursor.x = Math.max(20, Math.min(w - 20, cursor.x + rand(-40, 40)));
    cursor.y = Math.max(60, Math.min(h - 60, cursor.y + rand(-30, 30)));
    return cursor;
  }

  function dispatchAtCursor(EventCtor, type, extra) {
    try {
      const c = driftCursor();
      const target = document.elementFromPoint(c.x, c.y) ||
                     document.scrollingElement || document.documentElement;
      target.dispatchEvent(new EventCtor(type, {
        bubbles: true, cancelable: true,
        clientX: Math.round(c.x), clientY: Math.round(c.y),
        ...(extra || {}),
      }));
    } catch (_) {}
  }
  const dispatchWheel = (deltaY) => dispatchAtCursor(WheelEvent, "wheel", { deltaY, deltaMode: 0 });
  const dispatchMouseMove = () => dispatchAtCursor(MouseEvent, "mousemove");

  // Chunked, irregular scroll. Real users scroll in several small wheel
  // ticks over 200-600ms with varying deltas, sometimes overshoot then
  // micro-correct upward. Pure scrollBy(big) is a strong bot tell.
  async function humanScroll(totalDeltaY) {
    // Occasional micro-up "fidget" before scrolling down (humans often
    // re-read the last paragraph for a beat).
    if (Math.random() < 0.08) {
      const up = -rand(40, 140);
      dispatchWheel(up);
      window.scrollBy({ top: up, behavior: "instant" });
      await sleep(rand(80, 200));
    }

    const ticks = 3 + Math.floor(Math.random() * 6); // 3-8 ticks
    // Bias the deltas: first tick larger, last tick smaller (decel).
    const weights = [];
    let sum = 0;
    for (let i = 0; i < ticks; i++) {
      const w = (1.4 - i / ticks) * (0.6 + Math.random() * 0.8);
      weights.push(w); sum += w;
    }
    for (let i = 0; i < ticks; i++) {
      const delta = (totalDeltaY * weights[i]) / sum;
      dispatchWheel(delta);
      window.scrollBy({ top: delta, behavior: "instant" });
      // Inter-tick delay shrinks toward the end.
      await sleep(rand(18, 70));
      // Occasional mid-scroll mousemove.
      if (Math.random() < 0.3) dispatchMouseMove();
    }

    // Sometimes overshoot then correct upward — classic human behavior.
    if (Math.random() < 0.18) {
      await sleep(rand(120, 320));
      const back = -rand(30, 110);
      dispatchWheel(back);
      window.scrollBy({ top: back, behavior: "instant" });
    }
  }

  // Synthesize a more realistic click sequence on an anchor than the bare
  // .click() (which has isTrusted=false anyway, but at least mirrors what
  // a real pointer pipeline does so listeners attached to mousedown/mouseup
  // still fire). Falls back to .click() if the element is detached.
  function humanClickAnchor(a) {
    if (!a || !a.getBoundingClientRect) return false;
    try {
      const r = a.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      a.dispatchEvent(new MouseEvent("mouseover", opts));
      a.dispatchEvent(new MouseEvent("mousedown", opts));
      a.dispatchEvent(new MouseEvent("mouseup", opts));
      a.dispatchEvent(new MouseEvent("click", opts));
      return true;
    } catch (_) {
      try { a.click(); return true; } catch { return false; }
    }
  }

  // ---------- GraphQL response parser ----------
  // X returns full tweet objects in /i/api/graphql/.../UserTweets etc.
  // Walking the JSON is cheaper, more reliable, and survives DOM shuffles.
  function walk(obj, visit) {
    if (!obj || typeof obj !== "object") return;
    visit(obj);
    if (Array.isArray(obj)) { for (const x of obj) walk(x, visit); return; }
    for (const k in obj) walk(obj[k], visit);
  }

  // Map X's media kinds to a compact label set.
  function mediaTypeFromList(list) {
    if (!list || !list.length) return "";
    const kinds = new Set();
    for (const m of list) {
      const t = m.type || "";
      if (t === "photo") kinds.add("image");
      else if (t === "video") kinds.add("video");
      else if (t === "animated_gif") kinds.add("gif");
      else if (t) kinds.add(t);
    }
    return Array.from(kinds).join(",");
  }

  // Resolve any tweet date input to a stable local "YYYY-MM-DD HH:MM:SS"
  // string. Handles three cases:
  //   1. ISO 8601 from <time datetime> — exact timestamp, already absolute.
  //   2. X's GraphQL created_at: "Wed Oct 10 20:19:24 +0000 2018".
  //   3. Anything else parseable by `new Date(...)`.
  // Reason: X's visible label varies ("5h" / "Apr 27" / "Apr 27, 2023") but
  // the underlying timestamp is always absolute, so we recompute against the
  // user's local "today" instead of trusting the display string. The output
  // format is unambiguous for spreadsheets and date-aware tools.
  function formatLocalDate(input) {
    if (!input) return "";
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() + "-" +
      pad(d.getMonth() + 1) + "-" +
      pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" +
      pad(d.getSeconds())
    );
  }

  // X's visible label collapses anything <24h to "Nh" / "Nm". Because the
  // browser's local clock is the source of truth for "today", parsing the
  // absolute timestamp via new Date() and formatting via local getters
  // automatically lands on the correct local date even when the tweet shows
  // only "5h". No relative-arithmetic-vs-now is needed — the timestamp is
  // already absolute. The only edge case is a long-running session that
  // crosses local midnight; new Date() inside formatLocalDate is re-evaluated
  // on every call, so subsequent rows pick up the new local day.

  function rowFromTweetNode(node) {
    const legacy = node.legacy || {};
    const id = node.rest_id || legacy.id_str;
    const userLegacy = node.core?.user_results?.result?.legacy ||
                       node.user_results?.result?.legacy || {};
    const screen = userLegacy.screen_name || "";
    if (!id || !screen) return null;
    const text = node.note_tweet?.note_tweet_results?.result?.text ||
                 legacy.full_text || "";
    const url = postUrl(screen, id);
    const rt = legacy.retweeted_status_result?.result;
    const isRepost = !!rt;
    let repostedUrl = "";
    if (rt) {
      const rtId = rt.rest_id || rt.legacy?.id_str;
      const rtUser = rt.core?.user_results?.result?.legacy?.screen_name ||
                     rt.user_results?.result?.legacy?.screen_name;
      if (rtId && rtUser) repostedUrl = postUrl(rtUser, rtId);
    }
    const mediaList = legacy.extended_entities?.media || legacy.entities?.media || [];
    const typeMedia = mediaTypeFromList(mediaList);
    const isThread = !!(legacy.self_thread?.id_str ||
                        (legacy.conversation_id_str &&
                         legacy.conversation_id_str !== id &&
                         legacy.in_reply_to_user_id_str === userLegacy.id_str));
    return {
      username: screen,
      date: formatLocalDate(legacy.created_at),
      post_url: url,
      has_media: typeMedia ? "Y" : "N",
      type_media: typeMedia,
      has_repost: isRepost ? "Y" : "N",
      reposted_url: repostedUrl,
      has_thread: isThread ? "Y" : "N",
      text: text.replace(/\s+/g, " ").trim(),
    };
  }

  function looksLikeTweetNode(o) {
    return o && typeof o === "object" && (
      o.__typename === "Tweet" ||
      (o.rest_id && o.legacy && o.legacy.full_text !== undefined)
    );
  }

  function mergeRow(row) {
    const key = row.post_url;
    const existing = state.posts.get(key);
    if (existing) {
      for (const k of Object.keys(row)) {
        if (!existing[k] && row[k]) existing[k] = row[k];
      }
      return 0;
    }
    state.posts.set(key, row);
    state.recent.push(row);
    if (state.recent.length > state.recentCap) state.recent.shift();
    if (state.posts.size > state.postsCap) {
      // Map iterates insertion order; drop the oldest entry.
      const oldest = state.posts.keys().next().value;
      if (oldest !== undefined) state.posts.delete(oldest);
    }
    return 1;
  }

  // Drain unparsed captures, parse the JSON, free the body string.
  function parseCaptures() {
    let added = 0;
    for (; state.parseCursor < state.captures.length; state.parseCursor++) {
      const c = state.captures[state.parseCursor];
      if (c.parsed) continue;
      c.parsed = true;
      let json;
      try { json = JSON.parse(c.body || "null"); } catch { continue; }
      walk(json, (n) => {
        if (looksLikeTweetNode(n)) {
          const row = rowFromTweetNode(n);
          if (row) added += mergeRow(row);
        }
      });
      // Free the raw body — we already extracted what we need.
      state.captureBytes -= (c.body?.length || 0);
      c.body = "";
    }
    return added;
  }

  // System paths that look like profiles but aren't.
  const SYSTEM_HANDLES = new Set([
    "home","explore","notifications","messages","i","search","settings",
    "compose","bookmarks","lists","communities","jobs","tos","privacy",
    "login","logout","signup","about","tos","help","intent","share",
  ]);

  function pathHandle(pathname) {
    const m = pathname.match(/^\/([^/]+)(?:\/.*)?$/);
    if (!m) return null;
    const h = m[1].toLowerCase();
    if (SYSTEM_HANDLES.has(h)) return null;
    return m[1];
  }

  const PROFILE_RE = (p) => {
    const m = p.match(/^\/([^/]+)\/?$/);
    return m && !SYSTEM_HANDLES.has(m[1].toLowerCase());
  };
  const STATUS_RE = /^\/([^/]+)\/status\/(\d+)\/?$/;

  function isProfilePage() { return PROFILE_RE(location.pathname); }
  function isStatusPage() { return STATUS_RE.test(location.pathname); }

  function rememberProfileOwner() {
    if (state.profileOwner) return;
    const h = pathHandle(location.pathname);
    if (h && PROFILE_RE(location.pathname)) state.profileOwner = h;
  }

  // ---------- Repost / thread / media detection ----------
  const REPOST_RE = /(reposted|retweeted|리포스트(함|했어요)?|리트윗|転載|リポスト)/i;

  function detectRepost(tweet) {
    const ctx = tweet.querySelector(SEL.socialContext);
    if (!ctx) return false;
    const t = (ctx.textContent || "").trim();
    if (!t || t.length > 80) return false;
    return REPOST_RE.test(t);
  }

  function detectThreadTag(text) {
    // X creators commonly write "1/10", "1/", "🧵 1/10" inside the tweet body.
    const m = text.match(/(?:^|[\s🧵])(\d{1,3})\s*\/\s*(\d{1,3})(?:\s|$)/);
    if (m) return { isThread: true, index: m[1], total: m[2] };
    const open = text.match(/(?:^|[\s🧵])(\d{1,3})\s*\/(?:\s|$)/);
    if (open) return { isThread: true, index: open[1], total: "" };
    return { isThread: false, index: "", total: "" };
  }

  function hasShowThreadLink(tweet) {
    // X renders a "Show this thread" / "이 스레드 보기" link beneath self-reply tweets.
    const SHOW_RE = /(Show this thread|이\s*스레드\s*보기|スレッドを表示|Mostrar este hilo)/i;
    const links = tweet.querySelectorAll('a, span, div[role="link"]');
    for (const a of links) {
      const t = (a.textContent || "").trim();
      if (t && t.length < 40 && SHOW_RE.test(t)) return true;
    }
    return false;
  }

  function detectMediaTypes(tweet) {
    const kinds = new Set();
    if (tweet.querySelector(SEL.photo)) kinds.add("image");
    if (tweet.querySelector('video')) {
      // GIFs render as <video> with a tweet_video_thumb poster.
      const v = tweet.querySelector('video');
      const poster = (v?.getAttribute("poster") || "");
      if (/tweet_video_thumb/.test(poster)) kinds.add("gif");
      else kinds.add("video");
    }
    if (!kinds.size) {
      const imgs = tweet.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute("src") || "";
        if (/\/tweet_video_thumb\//.test(src)) kinds.add("gif");
        else if (/\/media\//.test(src)) kinds.add("image");
      }
    }
    return Array.from(kinds).join(",");
  }

  function getStatusUrl(tweet) {
    // The first <a href="/handle/status/ID"> wrapping a <time> element is the
    // tweet's permalink. Avoid analytics/photo sub-paths.
    const links = tweet.querySelectorAll(SEL.statusLink);
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)(?:\/(?:photo|video|analytics).*)?$/);
      if (m) {
        // Prefer one containing a <time> child (canonical permalink).
        if (a.querySelector("time")) return absUrl(`/${m[1]}/status/${m[2]}`);
      }
    }
    // Fallback: first matching href.
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (m) return absUrl(`/${m[1]}/status/${m[2]}`);
    }
    return "";
  }

  function getHandleFromStatusUrl(url) {
    try {
      const m = new URL(url).pathname.match(/^\/([^/]+)\/status\/\d+/);
      return m ? m[1] : "";
    } catch { return ""; }
  }

  function getTweetText(tweet) {
    const node = tweet.querySelector(SEL.tweetText);
    if (node) return (node.innerText || "").replace(/\s+/g, " ").trim();
    return (tweet.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  }

  function getTweetDate(tweet) {
    // X always renders the tweet's absolute timestamp in the <time> element's
    // datetime attribute, regardless of whether the visible label is a
    // relative ("5h"), short-date ("Apr 27"), or full-date ("Apr 27, 2023")
    // form. We parse that ISO string and reformat it in the user's local
    // timezone so "today" / "yesterday" lines up with the local clock.
    const t = tweet.querySelector('a[href*="/status/"] time[datetime]');
    return formatLocalDate(t?.getAttribute("datetime"));
  }

  function extractRow(tweet) {
    const url = getStatusUrl(tweet);
    if (!url) return null;
    const isRepost = detectRepost(tweet);
    const text = getTweetText(tweet);
    const tag = detectThreadTag(text);
    const showThread = hasShowThreadLink(tweet);
    const isThread = tag.isThread || showThread;
    const username = getHandleFromStatusUrl(url);
    const typeMedia = detectMediaTypes(tweet);
    return {
      username,
      date: getTweetDate(tweet),
      post_url: url,
      has_media: typeMedia ? "Y" : "N",
      type_media: typeMedia,
      has_repost: isRepost ? "Y" : "N",
      reposted_url: isRepost ? url : "",
      has_thread: isThread ? "Y" : "N",
      text,
    };
  }

  // Drop nested articles (quoted tweets render as a child <article>).
  function topLevelTweets() {
    const all = Array.from(document.querySelectorAll(SEL.tweet));
    return all.filter((el) => !el.parentElement?.closest(SEL.tweet));
  }

  // On a profile timeline, X only renders the owner's own posts + their
  // reposts. The author filter is therefore unnecessary AND harmful: a
  // repost's permalink points to the ORIGINAL author, so filtering by
  // profileOwner would drop every repost. We only apply the filter on
  // status (conversation) pages, where unrelated repliers appear.
  function harvest(authorFilter) {
    const onStatus = isStatusPage();
    let added = 0;
    for (const t of topLevelTweets()) {
      const row = extractRow(t);
      if (!row) continue;
      if (onStatus && authorFilter && row.username &&
          row.username.toLowerCase() !== authorFilter.toLowerCase() &&
          row.has_repost !== "Y") continue;
      added += mergeRow(row);
    }
    return added;
  }

  // ---------- Thread navigation ----------
  // Pick a tweet flagged as part of a thread we haven't entered yet.
  function pickThreadToEnter() {
    let best = null;
    for (const r of state.posts.values()) {
      if (r.has_thread !== "Y") continue;
      if (state.visited.has(r.post_url)) continue;
      if (state.profileOwner && r.username &&
          r.username.toLowerCase() !== state.profileOwner.toLowerCase()) continue;
      // Map iteration order is insertion order, so the first match is the
      // earliest-seen unvisited thread.
      best = r;
      break;
    }
    return best ? best.post_url : null;
  }

  function enterThread(url) {
    const target = new URL(url).pathname;
    // Only consider permalink anchors that are (a) inside a tweet article and
    // (b) wrap a <time> element — this is X's canonical "post permalink" anchor
    // and avoids accidentally clicking quoted-tweet wrappers or unrelated
    // /status/ links elsewhere on the page.
    const anchors = document.querySelectorAll(`${SEL.tweet} a[href*="/status/"]`);
    for (const a of anchors) {
      const href = (a.getAttribute("href") || "").split("?")[0];
      if (href !== target) continue;
      if (!a.querySelector("time")) continue;
      state.visited.add(url);
      state.profileScrollY = window.scrollY;
      humanClickAnchor(a);
      return true;
    }
    state.visited.add(url);
    return false;
  }

  // Click reply-thread expanders. Scoped strictly to inside tweet articles
  // (and on status pages, the conversation column) so we never click sidebar
  // links like "Followers", "Show more" suggestion modules, or trend items.
  const EXPANDER_PATTERNS = [
    /^Show\s+replies$/i,
    /^Show\s+more\s+repl(y|ies)/i,
    /^Show\s+probable\s+spam/i,
    /^답글\s*\d*\s*개?\s*더\s*보기$/,
    /^숨겨진\s*답글\s*보기$/,
    /^返信を表示/,
  ];

  function expanderRoots() {
    // Only search inside tweet articles plus the primary timeline column.
    const roots = Array.from(document.querySelectorAll(SEL.tweet));
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (primary) roots.push(primary);
    return roots;
  }

  // One click per cycle so we don't burst-fire — bot-detection signal.
  function clickExpanders() {
    for (const root of expanderRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").trim();
        if (!t || t.length > 50) continue;
        if (!EXPANDER_PATTERNS.some((re) => re.test(t))) continue;
        const el = n.parentElement;
        if (!el || el.dataset.xsExpanded === "1") continue;
        const anchor = el.closest("a[href]");
        if (anchor) {
          const href = anchor.getAttribute("href") || "";
          if (!/\/status\//.test(href)) continue;
        }
        try { el.click(); el.dataset.xsExpanded = "1"; return 1; } catch (_) {}
      }
    }
    return 0;
  }

  function reschedule(ms) { state.timer = setTimeout(loop, ms ?? jitteredDelay()); }

  async function maybeReadingPause() {
    state.actionCount++;
    if (state.actionCount < state.nextReadingPauseAt) return;
    state.actionCount = 0;
    state.nextReadingPauseAt = 25 + Math.floor(Math.random() * 25);
    await sleep(rand(4500, 12000));
  }

  async function loop() {
    if (!state.running) return;

    // Background tabs scraping is a strong bot signal. Re-check shortly.
    if (document.visibilityState !== "visible") {
      reschedule(2500);
      return;
    }

    rememberProfileOwner();

    // Drain network captures into rows on every tick — pure JSON parse,
    // no DOM walk. This is the fast path.
    const fromCaptures = parseCaptures();

    // ----- Status page -----
    if (isStatusPage()) {
      const expanded = clickExpanders();
      if (expanded > 0) await sleep(rand(700, 1300));

      const added = harvest(state.profileOwner) + fromCaptures;
      if (added === 0 && expanded === 0) state.permalinkIdle += 1;
      else state.permalinkIdle = 0;

      if (state.permalinkIdle >= state.maxPermalinkIdle) {
        state.permalinkIdle = 0;
        history.back();
        reschedule(1800);
        return;
      }
      await humanScroll(window.innerHeight * rand(0.7, 1.0));
      reschedule();
      return;
    }

    // ----- Profile mode -----
    if (state.profileScrollY && Math.abs(window.scrollY - state.profileScrollY) > 200) {
      window.scrollTo(0, state.profileScrollY);
      state.profileScrollY = 0;
      reschedule(600);
      return;
    }

    const expanded = clickExpanders();
    if (expanded > 0) await sleep(rand(600, 1100));

    const added = harvest(state.profileOwner) + fromCaptures;

    const enterUrl = pickThreadToEnter();
    if (enterUrl && enterThread(enterUrl)) {
      reschedule(rand(1300, 2000));
      return;
    }

    if (added === 0 && expanded === 0) state.idleScrolls += 1;
    else state.idleScrolls = 0;

    // End-of-feed detection: we're at (or near) the bottom of the scrollable
    // page AND the page hasn't grown AND no new rows / captures arrived.
    // Three concurrent "no growth at bottom" ticks mean X has nothing more
    // to give us, so stop instead of looping out the maxIdle clock.
    const scrollEl = document.scrollingElement || document.documentElement;
    const scrollH = scrollEl.scrollHeight;
    const atBottom = (window.scrollY + window.innerHeight) >= (scrollH - 200);
    const heightStable = scrollH === state.lastScrollHeight;
    const capsStable = state.captures.length === state.lastCaptureCount;
    if (atBottom && heightStable && capsStable && added === 0) {
      state.bottomIdle += 1;
    } else {
      state.bottomIdle = 0;
    }
    state.lastScrollHeight = scrollH;
    state.lastCaptureCount = state.captures.length;

    if (state.bottomIdle >= state.maxBottomIdle || state.idleScrolls >= state.maxIdle) {
      state.running = false;
      return;
    }

    // Periodic "reading" pause to break up perfectly periodic activity.
    await maybeReadingPause();

    if (state.idleScrolls >= 2) {
      const tweets = topLevelTweets();
      const last = tweets[tweets.length - 1];
      if (last) last.scrollIntoView({ block: "end", behavior: "instant" });
      await humanScroll(window.innerHeight * rand(0.85, 1.05));
    } else {
      await humanScroll(window.innerHeight * rand(0.7, 1.0));
    }
    reschedule();
  }

  // ---------- CSV export ----------
  const HEADERS = [
    "username", "date", "post_url",
    "has_media", "type_media",
    "has_repost", "reposted_url",
    "has_thread", "text",
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
    const handle = state.profileOwner || pathHandle(location.pathname) || "x";
    a.href = url;
    a.download = `x_${handle}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const handlers = {
    START(msg) {
      state.maxIdle = msg.maxIdle ?? state.maxIdle;
      state.delay = msg.delay ?? state.delay;
      state.idleScrolls = 0;
      state.permalinkIdle = 0;
      state.bottomIdle = 0;
      state.lastScrollHeight = 0;
      state.lastCaptureCount = state.captures.length;
      state.actionCount = 0;
      state.running = true;
      rememberProfileOwner();
      parseCaptures();
      harvest(state.profileOwner);
      clearTimeout(state.timer);
      state.timer = setTimeout(loop, jitteredDelay());
      return { ok: true, count: state.posts.size };
    },
    STOP() {
      state.running = false;
      clearTimeout(state.timer);
      return { ok: true, count: state.posts.size };
    },
    STATUS() {
      return { running: state.running, count: state.posts.size, items: state.recent };
    },
    CLEAR() {
      state.posts.clear();
      state.visited.clear();
      state.recent.length = 0;
      return { ok: true, count: 0 };
    },
    EXPORT() {
      const rows = Array.from(state.posts.values());
      download(rows);
      return { ok: true, count: rows.length };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const fn = handlers[msg?.type];
    if (!fn) return false;
    sendResponse(fn(msg));
    return true;
  });
})();
