// content.js — runs in ALL frames (main page + cafe_main iframe)

(() => {
  if (window.__CAFE_COLLECTOR_LOADED__) return;
  window.__CAFE_COLLECTOR_LOADED__ = true;

  const isMainFrame = window === window.top;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'COLLECT_DATA') {
      sendResponse(collectData());
      return true;
    }
    if (msg.type === 'DEBUG_DOM') {
      sendResponse(debugDOM());
      return true;
    }
    if (msg.type === 'DEBUG_COMMENTS') {
      sendResponse(debugComments());
      return true;
    }
  });

  // ─── COLLECT ────────────────────────────────────────────────

  function collectData() {
    // Main frame has no content — skip
    if (isMainFrame) {
      return { frameType: 'MAIN_FRAME', empty: true };
    }

    const data = {
      frameType: 'IFRAME',
      url: location.href,
      title: null,
      body: null,
      bodyHtml: null,
      author: null,
      date: null,
      comments: [],
    };

    // Title
    const titleEl = document.querySelector('h3.title_text');
    if (titleEl) data.title = titleEl.textContent.trim();

    // Author
    const authorEl = document.querySelector('.WriterInfo .nickname');
    if (authorEl) data.author = authorEl.textContent.trim();

    // Date
    const dateEl = document.querySelector('.article_info .date');
    if (dateEl) data.date = dateEl.textContent.trim();

    // Body — structured text from Naver Smart Editor 3
    const bodyEl = document.querySelector('.article_viewer .se-main-container');
    if (bodyEl) {
      data.body = extractBodyText(bodyEl);
      data.bodyHtml = bodyEl.innerHTML;
    }

    // Comments
    const items = document.querySelectorAll('ul.comment_list > li.CommentItem');
    items.forEach((item, i) => {
      const comment = extractComment(item, i);
      if (comment) data.comments.push(comment);
    });

    return data;
  }

  // ─── Body text extraction ──────────────────────────────────

  function extractBodyText(container) {
    const parts = [];

    // Smart Editor 3 uses .se-component blocks
    const components = container.querySelectorAll('.se-component');

    if (components.length > 0) {
      components.forEach(comp => {
        // Text blocks
        if (comp.classList.contains('se-text')) {
          const paragraphs = comp.querySelectorAll('.se-text-paragraph');
          paragraphs.forEach(p => {
            const text = p.textContent.trim();
            if (text) parts.push(text);
          });
        }
        // Image blocks — capture alt text or caption
        else if (comp.classList.contains('se-image') || comp.classList.contains('se-imageStrip')) {
          const img = comp.querySelector('img');
          const caption = comp.querySelector('.se-caption');
          if (caption?.textContent.trim()) {
            parts.push(`[image: ${caption.textContent.trim()}]`);
          } else if (img?.alt) {
            parts.push(`[image: ${img.alt}]`);
          } else {
            parts.push('[image]');
          }
        }
        // Link/OGTag blocks
        else if (comp.classList.contains('se-oglink')) {
          const title = comp.querySelector('.se-oglink-title');
          const url = comp.querySelector('a')?.href;
          if (title?.textContent.trim()) {
            parts.push(`[link: ${title.textContent.trim()}${url ? ' — ' + url : ''}]`);
          }
        }
        // Video/embed blocks
        else if (comp.classList.contains('se-video') || comp.classList.contains('se-oembed')) {
          parts.push('[video/embed]');
        }
        // Sticker blocks
        else if (comp.classList.contains('se-sticker')) {
          parts.push('[sticker]');
        }
      });
    } else {
      // Fallback: simple text extraction
      const text = container.textContent.trim();
      if (text) parts.push(text);
    }

    return parts.join('\n');
  }

  // ─── Comment extraction ────────────────────────────────────

  function extractComment(item, index) {
    const nickEl = item.querySelector('a.comment_nickname');
    const textEl = item.querySelector('span.text_comment');
    const dateEl = item.querySelector('span.comment_info_date');
    const stickerEl = item.querySelector('.CommentItemSticker img');

    const nickname = nickEl?.textContent?.trim() || '';
    const text = textEl?.textContent?.trim() || '';
    const date = dateEl?.textContent?.trim() || '';
    const stickerSrc = stickerEl?.src || null;

    // Determine comment type
    let type = 'text';
    let content = text;

    if (!text && stickerSrc) {
      type = 'sticker';
      content = stickerSrc;
    } else if (!text && !stickerSrc) {
      type = 'empty';
      content = '';
    }

    // Check if this is a reply (nested comment)
    const isReply = item.classList.contains('CommentItem--reply') ||
                    item.querySelector('.comment_thumb')?.classList.contains('reply') ||
                    item.closest('.comment_list_reply') !== null;

    return {
      index,
      type,
      author: nickname,
      text: content,
      date,
      isReply,
      commentId: item.id || null,
    };
  }

  // ─── DEBUG (kept for future use) ───────────────────────────

  function debugDOM() {
    const info = {
      frameType: isMainFrame ? 'MAIN_FRAME' : 'IFRAME',
      url: location.href,
      iframes: [],
      selectors: {},
    };

    if (isMainFrame) {
      const iframes = document.querySelectorAll('iframe');
      info.iframes = Array.from(iframes).map((iframe, i) => ({
        index: i,
        id: iframe.id || '(no id)',
        name: iframe.name || '(no name)',
        src: iframe.src || '(no src)',
        width: iframe.offsetWidth,
        height: iframe.offsetHeight,
      }));
    }

    const selectorMap = {
      'title: h3.title_text': 'h3.title_text',
      'body: .article_viewer .se-main-container': '.article_viewer .se-main-container',
      'date: .article_info .date': '.article_info .date',
      'author: .WriterInfo .nickname': '.WriterInfo .nickname',
      'comment_list: ul.comment_list': 'ul.comment_list',
      'comment_item: li.CommentItem': 'li.CommentItem',
      'comment_nick: a.comment_nickname': 'a.comment_nickname',
      'comment_text: span.text_comment': 'span.text_comment',
      'comment_date: span.comment_info_date': 'span.comment_info_date',
      'sticker: .CommentItemSticker img': '.CommentItemSticker img',
    };

    for (const [label, selector] of Object.entries(selectorMap)) {
      const el = document.querySelector(selector);
      info.selectors[label] = el
        ? { found: true, tag: el.tagName, text: el.textContent?.trim().substring(0, 100) }
        : { found: false };
    }

    return info;
  }

  function debugComments() {
    if (isMainFrame) return { frameType: 'MAIN_FRAME' };

    const items = document.querySelectorAll('ul.comment_list > li.CommentItem');
    return {
      frameType: 'IFRAME',
      count: items.length,
      first5: Array.from(items).slice(0, 5).map((item, i) => {
        const text = item.querySelector('span.text_comment')?.textContent?.trim();
        const sticker = item.querySelector('.CommentItemSticker img')?.src;
        return {
          index: i,
          id: item.id,
          author: item.querySelector('a.comment_nickname')?.textContent?.trim(),
          text: text || null,
          sticker: sticker || null,
          type: text ? 'text' : sticker ? 'sticker' : 'empty',
        };
      }),
    };
  }
})();
