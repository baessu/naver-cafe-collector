// instagram.js — Instagram profile feed scraper
// Collects posts from profile grid + individual post modals/pages.
// Instagram uses React-based SPA with virtualized rendering.
(() => {
  if (window.__igPostScraper) return;

  const TAG = '[IG-Scraper]';

  const state = {
    running: false,
    posts: new Map(), // postId -> post data
    seenEls: new WeakSet(),
    idleScrolls: 0,
    maxIdle: 8,
    timer: null,
    mode: null, // 'profile' | 'post'
  };
  window.__igPostScraper = state;

  console.log(TAG, '✅ Content script loaded', {
    url: location.href,
    pathname: location.pathname,
    timestamp: new Date().toISOString(),
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rng = (lo, hi) => lo + Math.random() * (hi - lo);

  // ─── Detect page mode ─────────────────────────────────

  function detectMode() {
    const path = location.pathname;
    // /p/XXXXX/ or /reel/XXXXX/ = single post
    if (/^\/(p|reel)\/[A-Za-z0-9_-]+/.test(path)) return 'post';
    // Profile page (/@username or /username/)
    return 'profile';
  }

  // ─── Profile mode: find post grid items ────────────────

  function getProfilePosts() {
    // Instagram profile grid: article elements or links to /p/ /reel/
    const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    const unique = new Map();
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
      if (!m) continue;
      const shortcode = m[2];
      if (!unique.has(shortcode)) {
        unique.set(shortcode, { el: a, shortcode, type: m[1] });
      }
    }
    return Array.from(unique.values());
  }

  // ─── Single post page: extract caption and metadata ────

  function extractPostPage() {
    const data = {
      shortcode: '',
      author: '',
      authorUrl: '',
      caption: '',
      time: '',
      postUrl: location.href,
      likes: '',
      comments: [],
      mediaType: '',
    };

    // Shortcode from URL
    const m = location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (m) {
      data.shortcode = m[2];
      data.mediaType = m[1] === 'reel' ? 'reel' : '';
    }

    // Author — header area with profile link
    const headerLink = document.querySelector('header a[href^="/"], article header a[href^="/"]');
    if (headerLink) {
      data.author = headerLink.textContent?.trim() || '';
      data.authorUrl = `https://www.instagram.com${headerLink.getAttribute('href')}`;
    }

    // Caption — typically in a span inside an h1 or the first large text block
    // Instagram wraps captions in specific containers
    const captionSelectors = [
      'h1._ap3a', // Modern Instagram
      'article span[class]', // Generic span in article
      'div[class] > span[dir="auto"]', // Alternative
    ];

    for (const sel of captionSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent?.trim();
        if (text && text.length > 5) {
          data.caption = text;
          break;
        }
      }
    }

    // If no caption found, try broader approach
    if (!data.caption) {
      // Look for the main text content after the author name
      const spans = document.querySelectorAll('article span, div[role="presentation"] span');
      let longestText = '';
      for (const s of spans) {
        const t = s.textContent?.trim();
        if (t && t.length > longestText.length && t.length > 10) {
          // Skip if it's a username, button, or UI element
          if (s.closest('[role="button"], button, header')) continue;
          if (/^(좋아요|likes?|comments?|팔로워|following|followers?)\s*\d*/i.test(t)) continue;
          longestText = t;
        }
      }
      data.caption = longestText;
    }

    // Timestamp
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl) {
      data.time = timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
    }

    // Likes
    const likeSection = document.querySelector('section span[class]');
    if (likeSection) {
      const t = likeSection.textContent?.trim();
      if (/\d/.test(t) && (t.includes('좋아요') || t.includes('like') || t.includes('명'))) {
        data.likes = t;
      }
    }

    // Media type detection (if not already reel)
    if (!data.mediaType) {
      if (document.querySelector('article video, video[src]')) data.mediaType = 'video';
      else if (document.querySelector('article img[srcset]')) data.mediaType = 'image';
      // Check carousel (multiple slides)
      if (document.querySelector('[aria-label*="다음"], [aria-label*="Next"], button[aria-label*="Go to slide"]')) {
        data.mediaType = 'carousel';
      }
    }

    // Comments
    const commentEls = document.querySelectorAll('ul li[role="menuitem"], div[role="button"] + ul li');
    for (const li of commentEls) {
      const authorEl = li.querySelector('a[href^="/"]');
      const textEl = li.querySelector('span:not(:first-child)');
      if (authorEl && textEl) {
        const commentAuthor = authorEl.textContent?.trim();
        const commentText = textEl.textContent?.trim();
        if (commentAuthor && commentText && commentText.length > 1) {
          data.comments.push({ author: commentAuthor, text: commentText });
        }
      }
    }

    return data;
  }

  // ─── Profile mode: extract info from grid thumbnail ────

  function extractFromGridItem(item) {
    const { el, shortcode, type } = item;
    const data = {
      shortcode,
      author: getProfileAuthor(),
      authorUrl: getProfileUrl(),
      caption: '',
      time: '',
      postUrl: `https://www.instagram.com/${type}/${shortcode}/`,
      likes: '',
      mediaType: type === 'reel' ? 'reel' : '',
      comments: [],
    };

    // Try to get alt text from image (contains caption preview)
    const img = el.querySelector('img[alt]');
    if (img) {
      const alt = img.getAttribute('alt') || '';
      // Instagram img alt format: "Photo by @user on Date. May be an image of..."
      // Or it contains the actual caption
      if (alt && !alt.startsWith('Photo shared') && !alt.startsWith('Photo by')) {
        data.caption = alt;
      }
    }

    // Detect media type from grid
    if (!data.mediaType) {
      if (el.querySelector('svg[aria-label*="Reel"], span[aria-label*="Reel"]')) data.mediaType = 'reel';
      else if (el.querySelector('svg[aria-label*="Carousel"], svg[aria-label*="슬라이드"]')) data.mediaType = 'carousel';
      else if (el.querySelector('svg[aria-label*="Video"], svg[aria-label*="동영상"]')) data.mediaType = 'video';
      else data.mediaType = 'image';
    }

    return data;
  }

  function getProfileAuthor() {
    // Get username from profile page header
    const h2 = document.querySelector('header h2, header h1');
    if (h2) return h2.textContent?.trim() || '';
    // Fallback: URL path
    const path = location.pathname.replace(/\//g, '');
    return path || '';
  }

  function getProfileUrl() {
    const path = location.pathname.split('/').filter(Boolean)[0];
    return path ? `https://www.instagram.com/${path}/` : location.href;
  }

  // ─── Harvest (profile mode) ────────────────────────────

  async function harvestProfile() {
    const items = getProfilePosts();
    let added = 0;

    for (const item of items) {
      if (state.posts.has(item.shortcode)) continue;

      const data = extractFromGridItem(item);
      state.posts.set(item.shortcode, data);
      added++;

      console.debug(TAG, `✅ Post: ${item.shortcode} (${data.mediaType})`);
    }

    if (added > 0) {
      console.log(TAG, `harvestProfile: +${added}, total: ${state.posts.size}`);
    }
    return added;
  }

  // ─── Harvest (single post mode) ────────────────────────

  async function harvestPost() {
    const data = extractPostPage();
    if (!data.shortcode) return 0;
    if (state.posts.has(data.shortcode)) return 0;

    // Try expanding "more" button for full caption
    const moreBtn = document.querySelector('button:has(> span), [role="button"]');
    if (moreBtn) {
      const t = moreBtn.textContent?.trim();
      if (/^(더\s*보기|more|자세히|…more)$/i.test(t)) {
        try {
          moreBtn.click();
          await sleep(300);
          // Re-extract after expansion
          const expanded = extractPostPage();
          if (expanded.caption.length > data.caption.length) {
            Object.assign(data, expanded);
          }
        } catch {}
      }
    }

    state.posts.set(data.shortcode, data);
    console.log(TAG, `✅ Post page: ${data.shortcode}`, {
      author: data.author,
      captionLen: data.caption.length,
      comments: data.comments.length,
    });
    return 1;
  }

  // ─── Auto-scroll tick ──────────────────────────────────

  async function tick() {
    if (!state.running) return;

    const beforeCount = state.posts.size;

    // Scroll down
    const scrollAmount = 500 + Math.random() * 500;
    window.scrollBy({ top: scrollAmount, behavior: 'auto' });

    // Wait for Instagram to load more content
    await sleep(1000 + Math.random() * 500);

    // Harvest based on mode
    if (state.mode === 'post') {
      await harvestPost();
      // Single post mode: no need to keep scrolling for more posts
      // But scroll to load more comments
      const added = state.posts.size - beforeCount;
      if (added === 0) state.idleScrolls++;
    } else {
      await harvestProfile();
      const added = state.posts.size - beforeCount;
      if (added > 0) {
        state.idleScrolls = 0;
      } else {
        state.idleScrolls++;
      }
    }

    // Check end condition
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 600;

    if (state.idleScrolls >= state.maxIdle && atBottom) {
      console.log(TAG, `⏹️ Done: ${state.posts.size} posts collected`);
      state.running = false;
      return;
    }

    // Aggressive scroll if idle
    if (state.idleScrolls > 4) {
      window.scrollBy({ top: 800, behavior: 'auto' });
      await sleep(500);
    }

    state.timer = setTimeout(tick, rng(200, 400));
  }

  // ─── CSV export ────────────────────────────────────────

  function toCsv(rows) {
    const headers = ['shortcode', 'author', 'caption', 'time', 'post_url', 'media_type', 'likes', 'comments_count'];
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        escape(r.shortcode),
        escape(r.author),
        escape(r.caption),
        escape(r.time),
        escape(r.postUrl),
        escape(r.mediaType),
        escape(r.likes),
        escape(r.comments?.length || 0),
      ].join(','));
    }
    return '\ufeff' + lines.join('\n');
  }

  function download(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const handle = location.pathname.replace(/\//g, '') || 'instagram';
    a.href = url;
    a.download = `instagram_${handle}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Diagnostic ────────────────────────────────────────

  window.__igDiag = function() {
    console.log(TAG, '=== DIAGNOSTIC ===');
    console.log(TAG, 'URL:', location.href);
    console.log(TAG, 'Mode:', detectMode());

    const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    console.log(TAG, `Post links found: ${postLinks.length}`);

    const unique = new Set();
    postLinks.forEach(a => {
      const m = a.getAttribute('href')?.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
      if (m) unique.add(m[2]);
    });
    console.log(TAG, `Unique posts: ${unique.size}`);

    // Profile info
    console.log(TAG, 'Profile author:', getProfileAuthor());

    // Grid items detail
    const items = getProfilePosts();
    items.slice(0, 3).forEach((item, i) => {
      console.group(TAG, `Grid item #${i}: ${item.shortcode} (${item.type})`);
      const img = item.el.querySelector('img[alt]');
      console.log('  img alt:', img?.getAttribute('alt')?.substring(0, 100));
      console.log('  href:', item.el.getAttribute('href'));
      console.groupEnd();
    });

    // Single post page info
    if (detectMode() === 'post') {
      const data = extractPostPage();
      console.log(TAG, 'Post data:', data);
    }
  };

  // ─── Message bridge ────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log(TAG, `📩 ${msg.type}`, { url: location.href, posts: state.posts.size, running: state.running });

    if (msg.type === 'START') {
      state.mode = detectMode();
      state.idleScrolls = 0;
      state.running = true;
      clearTimeout(state.timer);

      console.log(TAG, `▶️ START (mode: ${state.mode})`);
      window.__igDiag();

      // Initial harvest
      if (state.mode === 'post') {
        harvestPost().then(count => {
          console.log(TAG, `Initial harvest: ${count} posts`);
        });
      } else {
        harvestProfile().then(count => {
          console.log(TAG, `Initial harvest: ${count} posts`);
        });
      }

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
        text: r.caption,
        is_repost: false,
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
