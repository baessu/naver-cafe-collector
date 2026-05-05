// content.js — Naver Cafe Collector v0.6

(function() {
  const isMainFrame = window === window.top;

  function handler(msg, sender, sendResponse) {
    if (msg.type === 'COLLECT_DATA') {
      sendResponse(collectData(isMainFrame));
      return true;
    }
    if (msg.type === 'GET_LINKS') {
      sendResponse(getLinks(isMainFrame));
      return true;
    }
    if (msg.type === 'NAVIGATE_IFRAME') {
      // Main frame only: change iframe src
      if (isMainFrame) {
        const iframe = document.getElementById('cafe_main');
        if (iframe) {
          iframe.src = msg.url;
          sendResponse({ ok: true });
        } else {
          sendResponse({ error: 'iframe not found' });
        }
      }
      return true;
    }
  }

  if (window.__cafeCollectorListener__) {
    chrome.runtime.onMessage.removeListener(window.__cafeCollectorListener__);
  }
  window.__cafeCollectorListener__ = handler;
  chrome.runtime.onMessage.addListener(handler);
})();

// ─── GET_LINKS: Extract article links from current list page ──

function getLinks(isMainFrame) {
  const cafeIdMatch = location.href.match(/cafes\/(\d+)/);
  const clubIdMatch = location.href.match(/clubid=(\d+)/);
  const cafeId = cafeIdMatch?.[1] || clubIdMatch?.[1] || '';

  // Skip if this is a single article page (not a list)
  const isArticlePage = /\/articles\/\d+/.test(location.pathname) &&
                        !document.querySelector('.article-board-list, .article_profile, table.article-movie-sub');

  // Better check: if we see a list of a.article links (3+), it's a list page
  const articleLinks = document.querySelectorAll('a.article');
  const isListPage = articleLinks.length >= 3;

  if (!isListPage) {
    return { frameType: isMainFrame ? 'MAIN_FRAME' : 'IFRAME', cafeId, links: [], isListPage: false };
  }

  const links = [];
  const seen = new Set();

  articleLinks.forEach(a => {
    const href = a.getAttribute('href') || '';
    const articleId = extractArticleId(href);
    if (articleId && !seen.has(articleId)) {
      seen.add(articleId);
      links.push({ articleId, url: `https://cafe.naver.com/ca-fe/cafes/${cafeId}/articles/${articleId}`, title: a.textContent?.trim() || '' });
    }
  });

  // Fallback selectors if a.article didn't work
  if (links.length === 0) {
    const fallbackSelectors = ['a.article_title', 'a[href*="/articles/"]', 'a[href*="articleid="]'];
    for (const sel of fallbackSelectors) {
      document.querySelectorAll(sel).forEach(a => {
        const href = a.getAttribute('href') || '';
        const articleId = extractArticleId(href);
        if (articleId && !seen.has(articleId)) {
          seen.add(articleId);
          links.push({ articleId, url: `https://cafe.naver.com/ca-fe/cafes/${cafeId}/articles/${articleId}`, title: a.textContent?.trim() || '' });
        }
      });
      if (links.length > 0) break;
    }
  }

  return { frameType: isMainFrame ? 'MAIN_FRAME' : 'IFRAME', cafeId, links, isListPage: true, pageUrl: location.href };
}

function extractArticleId(href) {
  const newMatch = href.match(/\/articles\/(\d+)/);
  if (newMatch) return newMatch[1];
  const oldMatch = href.match(/articleid=(\d+)/i);
  if (oldMatch) return oldMatch[1];
  return null;
}

// ─── COLLECT_DATA: Extract from rendered article page ─────────

function collectData(isMainFrame) {
  // Try collecting regardless of frame — new UI renders in main frame
  const data = {
    frameType: 'IFRAME',
    url: location.href,
    title: null,
    body: null,
    author: null,
    date: null,
    comments: [],
  };

  const titleEl = document.querySelector('h3.title_text');
  if (titleEl) data.title = titleEl.textContent.trim();

  const authorEl = document.querySelector('.WriterInfo .nickname');
  if (authorEl) data.author = authorEl.textContent.trim();

  const dateEl = document.querySelector('.article_info .date');
  if (dateEl) data.date = dateEl.textContent.trim();

  const bodyEl = document.querySelector('.article_viewer .se-main-container');
  if (bodyEl) data.body = extractBodyText(bodyEl);

  document.querySelectorAll('ul.comment_list > li.CommentItem').forEach((item, i) => {
    data.comments.push(extractComment(item, i));
  });

  return data;
}

// ─── Body text extraction ─────────────────────────────────────

function extractBodyText(container) {
  const parts = [];
  const components = container.querySelectorAll('.se-component');

  if (components.length > 0) {
    components.forEach(comp => {
      if (comp.classList.contains('se-text')) {
        comp.querySelectorAll('.se-text-paragraph').forEach(p => {
          const text = p.textContent.trim();
          if (text) parts.push(text);
        });
      } else if (comp.classList.contains('se-image') || comp.classList.contains('se-imageStrip')) {
        const caption = comp.querySelector('.se-caption');
        const img = comp.querySelector('img');
        if (caption?.textContent.trim()) parts.push(`[image: ${caption.textContent.trim()}]`);
        else if (img?.alt) parts.push(`[image: ${img.alt}]`);
        else parts.push('[image]');
      } else if (comp.classList.contains('se-oglink')) {
        const title = comp.querySelector('.se-oglink-title');
        const url = comp.querySelector('a')?.href;
        if (title?.textContent.trim()) parts.push(`[link: ${title.textContent.trim()}${url ? ' — ' + url : ''}]`);
      } else if (comp.classList.contains('se-video') || comp.classList.contains('se-oembed')) {
        parts.push('[video/embed]');
      } else if (comp.classList.contains('se-sticker')) {
        parts.push('[sticker]');
      }
    });
  } else {
    const text = container.textContent.trim();
    if (text) parts.push(text);
  }

  return parts.join('\n');
}

// ─── Comment extraction ───────────────────────────────────────

function extractComment(item, index) {
  const nickEl = item.querySelector('a.comment_nickname');
  const textEl = item.querySelector('span.text_comment');
  const dateEl = item.querySelector('span.comment_info_date');
  const stickerEl = item.querySelector('.CommentItemSticker img');

  const text = textEl?.textContent?.trim() || '';
  const stickerSrc = stickerEl?.src || null;

  let type = 'text', content = text;
  if (!text && stickerSrc) { type = 'sticker'; content = stickerSrc; }
  else if (!text && !stickerSrc) { type = 'empty'; content = ''; }

  return {
    index,
    type,
    author: nickEl?.textContent?.trim() || '',
    text: content,
    date: dateEl?.textContent?.trim() || '',
    isReply: item.classList.contains('CommentItem--reply') ||
             item.closest('.comment_list_reply') !== null,
  };
}
