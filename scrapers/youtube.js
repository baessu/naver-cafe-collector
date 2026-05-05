// youtube.js — YouTube 댓글 스크롤 수집
// DOM 기반 자동 스크롤로 댓글을 수집한다.

(() => {
  if (window.__ytCommentScraper) return;

  const state = {
    running: false,
    comments: new Map(), // commentId -> comment data
    seenEls: new WeakSet(),
    idleScrolls: 0,
    maxIdle: 5,
    timer: null,
  };
  window.__ytCommentScraper = state;

  const SEL = {
    commentThread: 'ytd-comment-thread-renderer',
    comment: '#comment',
    authorName: '#author-text span',
    authorLink: '#author-text',
    commentText: '#content-text',
    publishedTime: '.published-time-text a, #published-time-text a',
    likeCount: '#vote-count-middle',
    replyButton: '#more-replies button, [aria-label*="답글"]',
    replies: 'ytd-comment-renderer',
    sortMenu: 'tp-yt-paper-listbox#menu',
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ─── Harvest comments from DOM ──────────────────────────

  function harvestAll() {
    const threads = document.querySelectorAll(SEL.commentThread);
    let added = 0;

    threads.forEach(thread => {
      if (state.seenEls.has(thread)) return;
      state.seenEls.add(thread);

      // Main comment
      const mainComment = thread.querySelector(SEL.comment);
      if (mainComment) {
        const data = extractComment(mainComment, false);
        if (data && !state.comments.has(data.id)) {
          state.comments.set(data.id, data);
          added++;
        }
      }

      // Replies (if expanded)
      const replies = thread.querySelectorAll(`#replies ${SEL.replies}`);
      replies.forEach(reply => {
        const data = extractComment(reply, true);
        if (data && !state.comments.has(data.id)) {
          state.comments.set(data.id, data);
          added++;
        }
      });
    });

    return added;
  }

  function extractComment(el, isReply) {
    const authorEl = el.querySelector(SEL.authorName);
    const authorLinkEl = el.querySelector(SEL.authorLink);
    const textEl = el.querySelector(SEL.commentText);
    const timeEl = el.querySelector(SEL.publishedTime);
    const likeEl = el.querySelector(SEL.likeCount);

    const author = authorEl?.textContent?.trim() || '';
    const text = textEl?.textContent?.trim() || '';
    if (!text) return null;

    const authorUrl = authorLinkEl?.href || '';
    const time = timeEl?.textContent?.trim() || '';
    const likes = parseInt(likeEl?.textContent?.trim() || '0') || 0;

    // Generate stable ID from author + text prefix
    const id = `${author}:${text.substring(0, 50)}`;

    return {
      id,
      author,
      authorUrl,
      text,
      time,
      likes,
      isReply,
    };
  }

  // ─── Auto-scroll tick ───────────────────────────────────

  async function tick() {
    if (!state.running) return;

    const beforeCount = state.comments.size;

    // Scroll down
    window.scrollBy({ top: 600 + Math.random() * 400, behavior: 'smooth' });
    await sleep(1500 + Math.random() * 500);

    // Harvest
    harvestAll();

    const added = state.comments.size - beforeCount;

    if (added > 0) {
      state.idleScrolls = 0;
    } else {
      state.idleScrolls++;
    }

    // Check if we're at the bottom
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 500;

    if (state.idleScrolls >= state.maxIdle && atBottom) {
      state.running = false;
      return;
    }

    state.timer = setTimeout(tick, 200 + Math.random() * 300);
  }

  // ─── CSV export ─────────────────────────────────────────

  function toCsv(rows) {
    const headers = ['author', 'text', 'time', 'likes', 'is_reply', 'author_url'];
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(headers.map(h => escape(r[h])).join(','));
    }
    return '\ufeff' + lines.join('\n');
  }

  function download(rows) {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const videoId = new URLSearchParams(location.search).get('v') || 'youtube';
    a.href = url;
    a.download = `youtube_comments_${videoId}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Message bridge ─────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START') {
      state.idleScrolls = 0;
      state.running = true;
      clearTimeout(state.timer);

      // Scroll to comments section first
      const commentsSection = document.querySelector('ytd-comments#comments');
      if (commentsSection) {
        commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      setTimeout(() => { state.timer = setTimeout(tick, 1000); }, 1500);
      sendResponse({ ok: true, count: state.comments.size });
      return true;
    }
    if (msg.type === 'STOP') {
      state.running = false;
      clearTimeout(state.timer);
      sendResponse({ ok: true, count: state.comments.size });
      return true;
    }
    if (msg.type === 'STATUS') {
      const rows = Array.from(state.comments.values());
      const preview = rows.slice(-12).reverse().map(r => ({
        author: r.author,
        text: r.text,
        is_repost: false,
        posted_date: r.time,
      }));
      sendResponse({ running: state.running, count: rows.length, preview });
      return true;
    }
    if (msg.type === 'CLEAR') {
      state.comments.clear();
      state.seenEls = new WeakSet();
      sendResponse({ ok: true, count: 0 });
      return true;
    }
    if (msg.type === 'EXPORT') {
      const rows = Array.from(state.comments.values());
      download(rows);
      sendResponse({ ok: true, count: rows.length });
      return true;
    }
  });
})();
