// facebook.js — Facebook profile/page feed scraper
// Handles Facebook's virtualized list (posts only render when visible in viewport).
(() => {
  if (window.__fbPostScraper) return;

  const TAG = '[FB-Scraper]';

  const state = {
    running: false,
    posts: new Map(), // postId -> post data
    seenEls: new WeakSet(),
    idleScrolls: 0,
    maxIdle: 8,
    timer: null,
  };
  window.__fbPostScraper = state;

  console.log(TAG, '✅ Content script loaded', {
    url: location.href,
    pathname: location.pathname,
    timestamp: new Date().toISOString(),
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rng = (lo, hi) => lo + Math.random() * (hi - lo);

  // ─── Find RENDERED posts (skip virtualized placeholders) ──

  function getRenderedPosts() {
    const articles = document.querySelectorAll('[role="article"]');
    const rendered = [];

    for (const el of articles) {
      // Skip virtualized placeholders (empty shells with min-height)
      const virt = el.querySelector('[data-virtualized="true"]');
      if (virt) continue;

      // Must have actual content (links or text)
      const hasLinks = el.querySelectorAll('a[href]').length > 2;
      const hasText = el.textContent.trim().length > 50;
      if (!hasLinks && !hasText) continue;

      rendered.push(el);
    }

    return rendered;
  }

  // ─── Post ID extraction ─────────────────────────────────

  function getPostId(el) {
    // Strategy 1: Look for any link with post identifiers
    const allLinks = el.querySelectorAll('a[href]');
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      // pfbid format (new Facebook ID)
      let m = href.match(/(pfbid[A-Za-z0-9]{20,})/);
      if (m) return m[1];
      // /posts/123456
      m = href.match(/\/posts\/(\d+)/);
      if (m) return `post_${m[1]}`;
      // story_fbid=123456
      m = href.match(/story_fbid=(\d+)/);
      if (m) return `story_${m[1]}`;
      // /videos/123456
      m = href.match(/\/videos\/(\d+)/);
      if (m) return `video_${m[1]}`;
      // /reel/123456
      m = href.match(/\/reel\/(\d+)/);
      if (m) return `reel_${m[1]}`;
      // /photo?fbid=123456
      m = href.match(/fbid=(\d+)/);
      if (m) return `photo_${m[1]}`;
      // /permalink.php?story_fbid=pfbid...
      m = href.match(/permalink.*?(pfbid[A-Za-z0-9]+)/);
      if (m) return m[1];
    }

    // Strategy 2: Generate ID from content hash
    const text = extractText(el);
    if (text && text.length > 20) {
      return `hash_${simpleHash(text.substring(0, 150))}`;
    }

    // Strategy 3: Use element position as last resort
    const rect = el.getBoundingClientRect();
    return `pos_${Math.round(rect.top + window.scrollY)}`;
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // ─── Text extraction ───────────────────────���────────────

  function extractText(el) {
    // Method 1: data-ad attributes (ad posts)
    const adBlocks = el.querySelectorAll('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
    if (adBlocks.length > 0) {
      return Array.from(adBlocks).map(b => b.textContent?.trim()).filter(Boolean).join('\n');
    }

    // Method 2: Find the main content area (usually after the header/author section)
    // Facebook wraps post text in nested divs with dir="auto"
    const dirAuto = el.querySelectorAll('[dir="auto"]');
    const texts = [];
    const seen = new Set();

    for (const d of dirAuto) {
      const t = d.textContent?.trim();
      if (!t || t.length < 3) continue;

      // Skip author names (inside headings or strong)
      if (d.closest('h1, h2, h3, h4, h5, h6')) continue;

      // Skip UI elements (buttons, navigation)
      if (d.closest('[role="button"], [role="navigation"], [role="banner"]')) continue;

      // Skip short utility text (reactions, shares, comments labels)
      if (t.length < 15 && /^(좋아요|Like|Comment|Share|공유|답글|Reply|달|명|개)\s*\d*$/.test(t)) continue;
      if (/^\d+[KMk만천]?\s*(좋아요|likes?|comments?|shares?|공유|명)$/i.test(t)) continue;

      // Avoid duplicates (parent elements contain child text)
      if (seen.has(t)) continue;

      // Check if this text is a subset of already captured text
      let isSubset = false;
      for (const existing of seen) {
        if (existing.includes(t)) { isSubset = true; break; }
      }
      if (isSubset) continue;

      // Remove previously captured text that is subset of this one
      for (const existing of [...seen]) {
        if (t.includes(existing)) {
          seen.delete(existing);
          const idx = texts.indexOf(existing);
          if (idx >= 0) texts.splice(idx, 1);
        }
      }

      seen.add(t);
      texts.push(t);
    }

    return texts.join('\n').substring(0, 5000);
  }

  // ─── Author extraction ───────────────��──────────────────

  function getAuthor(el) {
    // Look for the first meaningful link inside a heading
    const headings = el.querySelectorAll('h2, h3, h4, strong');
    for (const h of headings) {
      const a = h.querySelector('a[href]');
      if (!a) continue;
      const name = a.textContent?.trim();
      const href = a.getAttribute('href') || '';
      if (name && name.length < 100 && name.length > 1 && !href.includes('#')) {
        const url = href.startsWith('/') ? `https://www.facebook.com${href.split('?')[0]}` : href.split('?')[0];
        return { name, url };
      }
    }

    // Fallback: first link that looks like a profile
    const profileLinks = el.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]');
    for (const a of profileLinks) {
      const href = a.getAttribute('href') || '';
      const name = a.textContent?.trim();
      if (!name || name.length > 80 || name.length < 2) continue;
      // Must be a simple profile path, not a post/photo/etc
      if (/^\/([\w.]+)\/?$/.test(href) || /facebook\.com\/([\w.]+)\/?$/.test(href)) {
        const url = href.startsWith('/') ? `https://www.facebook.com${href}` : href;
        return { name, url: url.split('?')[0] };
      }
    }

    // Fallback: aria-label
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(/^(.+?)(?:의 게시물|'s post|shared|님)/);
    if (m) return { name: m[1].trim(), url: '' };

    return { name: '', url: '' };
  }

  // ─── Timestamp extraction ───────────────────────────────

  function getTimestamp(el) {
    // Facebook timestamps are usually in links with aria-label containing full date
    const allLinks = el.querySelectorAll('a[aria-label]');
    for (const a of allLinks) {
      const label = a.getAttribute('aria-label') || '';
      // Full date formats
      if (/\d{4}[년/.-]/.test(label) || /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(label)) {
        return label;
      }
    }

    // Look for relative timestamps in visible text
    // Facebook often puts time in small text near the author
    const allText = el.querySelectorAll('a[href*="/posts/"], a[href*="pfbid"], a[href*="story_fbid"]');
    for (const a of allText) {
      // The sibling or child might contain time info
      const parent = a.closest('[class]');
      if (parent) {
        const spans = parent.querySelectorAll('span, a');
        for (const s of spans) {
          const t = s.textContent?.trim();
          if (!t || t.length > 30) continue;
          if (/^(\d+\s*(시간|분|초|일|주|개월|년|h|m|d|w|mo|yr|min|sec)s?\s*(전|ago)?|방금|Just now|어제|Yesterday|그저께)$/i.test(t)) {
            return t;
          }
        }
      }
    }

    // Broader search for time-like text
    const spans = el.querySelectorAll('span');
    for (const s of spans) {
      const t = s.textContent?.trim();
      if (!t || t.length > 30) continue;
      if (/^(\d+\s*(시간|분|초|일|주|개월|년|hours?|minutes?|days?|weeks?|months?|years?)s?\s*(전|ago)?|방금|Just now|어제|Yesterday)$/i.test(t)) {
        return t;
      }
    }
    return '';
  }

  // ─── Post URL extraction ──────────────────��─────────────

  function getPostUrl(el) {
    const allLinks = el.querySelectorAll('a[href]');
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      if (/pfbid[A-Za-z0-9]{20,}/.test(href) || /\/posts\/\d+/.test(href) || /story_fbid=\d+/.test(href)) {
        if (href.startsWith('/')) return `https://www.facebook.com${href.split('?')[0]}`;
        try { const u = new URL(href); u.search = ''; return u.toString(); } catch {}
      }
    }
    return '';
  }

  // ─── Media detection ────────────────────────────────────

  function detectMedia(el) {
    if (el.querySelector('video, [data-video-id]')) return 'video';
    if (el.querySelector('a[href*="/reel/"]')) return 'reel';
    const imgs = el.querySelectorAll('img');
    let hasContentImage = false;
    for (const img of imgs) {
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height')) || 0;
      if (w > 100 && h > 100) hasContentImage = true;
    }
    if (hasContentImage) return 'image';
    if (el.querySelector('a[href*="/events/"]')) return 'event';
    return '';
  }

  // ─── Shared post detection ──────────────────────────────

  function isSharedPost(el) {
    const innerArticles = el.querySelectorAll('[role="article"]');
    if (innerArticles.length > 0) return true;
    const allText = el.textContent || '';
    if (/shared a (post|memory|photo|video|link)|공유했습니다|님의 게시물을 공유/.test(allText)) return true;
    return false;
  }

  // ─── Expand "See more" ──────────────────────────────────

  function expandSeeMore(el) {
    // Try role="button" with "See more" / "더 보기" text
    const btns = el.querySelectorAll('[role="button"], span[class], div[role="button"]');
    for (const btn of btns) {
      const t = btn.textContent?.trim();
      if (/^(더\s*보기|See\s*more|もっと見る|자세히\s*보기)$/i.test(t)) {
        try {
          btn.click();
          console.debug(TAG, '  Expanded "See more"');
          return true;
        } catch {}
      }
    }
    // Also try: Facebook sometimes uses a nested span inside a div[dir="auto"]
    const spans = el.querySelectorAll('div[dir="auto"] span[role="button"], div[dir="auto"] > span');
    for (const s of spans) {
      const t = s.textContent?.trim();
      if (/^(더\s*보기|See\s*more)$/i.test(t)) {
        try {
          s.click();
          console.debug(TAG, '  Expanded "See more" (nested span)');
          return true;
        } catch {}
      }
    }
    return false;
  }

  // ─── Harvest ─────────────────────────��──────────────────

  async function harvestAll() {
    const containers = getRenderedPosts();
    let added = 0;
    let skippedSeen = 0;
    let skippedNoId = 0;
    let skippedDuplicate = 0;

    for (const el of containers) {
      if (state.seenEls.has(el)) { skippedSeen++; continue; }
      state.seenEls.add(el);

      // Expand truncated text — wait for DOM to update after click
      const expanded = expandSeeMore(el);
      if (expanded) {
        await sleep(300); // Wait for Facebook to render full text
      }

      const id = getPostId(el);
      if (!id) {
        skippedNoId++;
        console.debug(TAG, `  ⚠️ No ID for article, innerHTML length: ${el.innerHTML.length}, links: ${el.querySelectorAll('a[href]').length}`);
        continue;
      }
      if (state.posts.has(id)) { skippedDuplicate++; continue; }

      const author = getAuthor(el);
      const text = extractText(el);
      const time = getTimestamp(el);
      const media = detectMedia(el);
      const shared = isSharedPost(el);
      const url = getPostUrl(el);

      console.debug(TAG, `✅ NEW POST:`, {
        id: id.substring(0, 40),
        author: author.name,
        textPreview: text.substring(0, 80) + (text.length > 80 ? '...' : ''),
        time,
        url: url.substring(0, 60),
        media,
        shared,
      });

      state.posts.set(id, {
        id,
        author: author.name,
        authorUrl: author.url,
        text,
        time,
        postUrl: url,
        mediaType: media,
        isShared: shared,
      });
      added++;
    }

    console.log(TAG, `harvestAll:`, {
      rendered: containers.length,
      added,
      skippedSeen,
      skippedNoId,
      skippedDuplicate,
      total: state.posts.size,
    });

    return added;
  }

  // ─── Auto-scroll tick ─────────────────────��─────────────

  async function tick() {
    if (!state.running) return;

    const beforeCount = state.posts.size;

    // Fast scroll — use 'auto' not 'smooth' for speed
    const scrollAmount = 600 + Math.random() * 400;
    window.scrollBy({ top: scrollAmount, behavior: 'auto' });

    // Short wait for Facebook to hydrate virtualized posts
    await sleep(800 + Math.random() * 400);

    // Harvest (async — waits for "See more" expansion)
    await harvestAll();

    const added = state.posts.size - beforeCount;

    if (added > 0) {
      state.idleScrolls = 0;
    } else {
      state.idleScrolls++;
    }

    // Check end of feed
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 600;

    if (state.idleScrolls >= state.maxIdle && atBottom) {
      console.log(TAG, `⏹️ Done: ${state.posts.size} posts collected`);
      state.running = false;
      return;
    }

    // If idle for a while, scroll more aggressively to trigger loading
    if (state.idleScrolls > 3) {
      window.scrollBy({ top: 800, behavior: 'auto' });
      await sleep(400);
    }

    state.timer = setTimeout(tick, rng(100, 250));
  }

  // ─── CSV export ────────────���────────────────────────────

  function toCsv(rows) {
    const headers = ['author', 'text', 'time', 'post_url', 'media_type', 'is_shared', 'author_url'];
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        escape(r.author),
        escape(r.text),
        escape(r.time),
        escape(r.postUrl),
        escape(r.mediaType),
        escape(r.isShared ? 'Y' : 'N'),
        escape(r.authorUrl),
      ].join(','));
    }
    return '\ufeff' + lines.join('\n');
  }

  function download(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const handle = location.pathname.replace(/\//g, '') || 'facebook';
    a.href = url;
    a.download = `facebook_${handle}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Diagnostic (console: __fbDiag()) ───────────────────

  window.__fbDiag = function() {
    console.log(TAG, '=== FULL DIAGNOSTIC ===');
    console.log(TAG, 'URL:', location.href);

    // Check all articles
    const articles = document.querySelectorAll('[role="article"]');
    console.log(TAG, `Total [role="article"]: ${articles.length}`);

    let renderedCount = 0;
    articles.forEach((el, i) => {
      const virt = el.querySelector('[data-virtualized="true"]');
      const contentLen = el.innerHTML.length;
      const linkCount = el.querySelectorAll('a[href]').length;

      if (virt || contentLen < 300) {
        if (i < 3) console.log(TAG, `  Article #${i}: VIRTUALIZED (placeholder, ${contentLen} chars)`);
        return;
      }

      renderedCount++;
      if (renderedCount <= 3) {
        console.group(TAG, `Article #${i} (RENDERED, ${contentLen} chars, ${linkCount} links)`);
        console.log('aria-label:', el.getAttribute('aria-label'));

        console.log('Links with href (first 15):');
        const links = el.querySelectorAll('a[href]');
        links.forEach((a, j) => {
          if (j >= 15) return;
          const href = a.getAttribute('href') || '';
          const text = a.textContent?.trim().substring(0, 40);
          const ariaLabel = a.getAttribute('aria-label')?.substring(0, 40) || '';
          console.log(`  [${j}] href="${href.substring(0, 100)}" text="${text}" aria="${ariaLabel}"`);
        });

        console.log('[dir="auto"] elements (first 8):');
        el.querySelectorAll('[dir="auto"]').forEach((d, j) => {
          if (j >= 8) return;
          const t = d.textContent?.trim();
          console.log(`  [${j}] tag=${d.tagName} len=${t?.length} text="${t?.substring(0, 100)}"`);
        });

        console.log('Headings:');
        el.querySelectorAll('h1, h2, h3, h4, h5, h6, strong').forEach((h, j) => {
          if (j >= 5) return;
          console.log(`  [${j}] ${h.tagName} "${h.textContent?.trim().substring(0, 60)}"`);
        });

        console.log('innerHTML (first 3000):');
        console.log(el.innerHTML.substring(0, 3000));
        console.groupEnd();
      }
    });

    console.log(TAG, `Summary: ${renderedCount} rendered, ${articles.length - renderedCount} virtualized`);

    // Also check if posts are in a different container
    console.log(TAG, 'Alternative containers:');
    console.log('  [data-pagelet*="Feed"]:', document.querySelectorAll('[data-pagelet*="Feed"]').length);
    console.log('  [data-pagelet*="ProfileTimeline"]:', document.querySelectorAll('[data-pagelet*="ProfileTimeline"]').length);
    console.log('  [role="feed"]:', document.querySelectorAll('[role="feed"]').length);
    console.log('  [role="main"]:', document.querySelectorAll('[role="main"]').length);
  };

  // ─── Message bridge ───────────────────���─────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log(TAG, `📩 ${msg.type}`, { url: location.href, posts: state.posts.size, running: state.running });

    if (msg.type === 'START') {
      state.idleScrolls = 0;
      state.running = true;
      clearTimeout(state.timer);

      // Run diagnostic first to understand page state
      console.log(TAG, '▶️ START');
      window.__fbDiag();

      // Initial harvest (async — expand "See more" buttons)
      harvestAll().then(count => {
        console.log(TAG, `Initial harvest: ${count} posts`);
      });

      state.timer = setTimeout(tick, 1500);
      sendResponse({ ok: true, count: state.posts.size });
      return true;
    }
    if (msg.type === 'STOP') {
      console.log(TAG, '⏹️ STOP');
      state.running = false;
      clearTimeout(state.timer);
      sendResponse({ ok: true, count: state.posts.size });
      return true;
    }
    if (msg.type === 'STATUS') {
      const rows = Array.from(state.posts.values());
      const preview = rows.slice(-12).reverse().map(r => ({
        author: r.author,
        text: r.text,
        is_repost: r.isShared,
        posted_date: r.time,
      }));
      sendResponse({ running: state.running, count: rows.length, preview });
      return true;
    }
    if (msg.type === 'CLEAR') {
      console.log(TAG, '🗑️ CLEAR');
      state.posts.clear();
      state.seenEls = new WeakSet();
      sendResponse({ ok: true, count: 0 });
      return true;
    }
    if (msg.type === 'EXPORT') {
      const rows = Array.from(state.posts.values());
      console.log(TAG, `📥 EXPORT: ${rows.length} posts`);
      download(rows);
      sendResponse({ ok: true, count: rows.length });
      return true;
    }
  });
})();
