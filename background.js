// background.js — Service Worker: handles all tab navigation (pagination + article fetch)

// Open side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Article content lives in an async-loaded ca-fe iframe that renders well after
// the main frame reports 'complete'. Poll for it instead of guessing a delay.
const CONTENT_TIMEOUT = 12000;   // max wait for the iframe to render an article
const CONTENT_POLL = 250;        // gap between content probes
const ARTICLE_RETRIES = 2;       // full re-navigations before giving up
const ARTICLE_GAP = 600;         // gap between articles — eases Naver throttling

// Phase 1 (link collection) and Phase 2 (article fetch) each track their own
// state so the panel can drive them as two separate steps.
let linkState = {
  running: false,
  aborted: false,
  progress: { current: 0, total: 0, phase: '' },
  links: null,
  error: null,
};

let batchState = {
  running: false,
  aborted: false,
  progress: { current: 0, total: 0, phase: '' },
  result: null,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ─── Phase 1: collect links across a page range ───────────────
  if (msg.type === 'LINKS_START') {
    collectLinks(msg.tabId, msg.listBaseUrl, msg.startPage, msg.endPage);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'LINKS_STATUS') {
    sendResponse({ ...linkState });
    return true;
  }
  if (msg.type === 'LINKS_STOP') {
    linkState.aborted = true;
    sendResponse({ ok: true });
    return true;
  }
  // ─── Phase 2: fetch article bodies for a resolved link list ───
  if (msg.type === 'BATCH_START') {
    runBatch(msg.tabId, msg.cafeId, msg.links);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'BATCH_RETRY') {
    retryFailed(msg.tabId, msg.cafeId, msg.links);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'BATCH_STATUS') {
    sendResponse({ ...batchState });
    return true;
  }
  if (msg.type === 'BATCH_STOP') {
    batchState.aborted = true;
    sendResponse({ ok: true });
    return true;
  }
});

// Collect article links across pages startPage..endPage. Unlike the old flow,
// this navigates to every page in the range fresh — it does not depend on which
// page the user currently has open, so "5~10 페이지" means exactly that.
async function collectLinks(tabId, listBaseUrl, startPage, endPage) {
  linkState = {
    running: true,
    aborted: false,
    progress: { current: 0, total: endPage - startPage + 1, phase: '링크 수집 준비 중...' },
    links: null,
    cafeId: listBaseUrl.match(/cafes\/(\d+)/)?.[1] || '',
    error: null,
  };

  const allLinks = [];
  try {
    for (let page = startPage; page <= endPage; page++) {
      if (linkState.aborted) break;

      linkState.progress.current = page - startPage + 1;
      linkState.progress.phase = `링크 수집: 페이지 ${page}/${endPage}`;

      const pageUrl = buildPageUrl(listBaseUrl, page);
      await navigateAndWait(tabId, pageUrl);
      await injectScript(tabId);
      await sleep(300);

      const links = await getLinksFromTab(tabId);
      if (links.length > 0) {
        links.forEach(l => { l.page = page; });
        allLinks.push(...links);
      } else if (page > startPage) {
        break; // ran past the last page
      }
    }

    // Deduplicate by article id, keeping list order.
    linkState.links = [...new Map(allLinks.map(l => [l.articleId, l])).values()];
  } catch (err) {
    linkState.error = err.message;
    linkState.links = allLinks;
  }

  linkState.running = false;
  linkState.progress.phase = 'done';
}

// Phase 2: fetch bodies for an already-resolved (and possibly sliced) link list.
async function runBatch(tabId, cafeId, links) {
  batchState = {
    running: true,
    aborted: false,
    progress: { current: 0, total: links.length, phase: '수집 준비 중...' },
    result: { cafeId, articles: [], errors: [] },
  };

  try {
    for (let i = 0; i < links.length; i++) {
      if (batchState.aborted) break;

      batchState.progress.current = i + 1;
      const data = await fetchArticle(tabId, cafeId, links[i]);
      batchState.result.articles.push(data);
      await sleep(ARTICLE_GAP);
    }
  } catch (err) {
    batchState.result.errors.push({ phase: 'fatal', error: err.message });
  }

  batchState.running = false;
  batchState.progress.phase = 'done';
}

// Re-collect only the articles that came back empty on a previous run.
async function retryFailed(tabId, cafeId, links) {
  batchState = {
    running: true,
    aborted: false,
    progress: { current: 0, total: links.length, phase: '재수집 준비 중...' },
    result: { cafeId, articles: [], errors: [] },
  };

  try {
    for (let i = 0; i < links.length; i++) {
      if (batchState.aborted) break;

      batchState.progress.current = i + 1;
      const data = await fetchArticle(tabId, cafeId, links[i]);
      batchState.result.articles.push(data);
      await sleep(ARTICLE_GAP);
    }
  } catch (err) {
    batchState.result.errors.push({ phase: 'fatal', error: err.message });
  }

  batchState.running = false;
  batchState.progress.phase = 'done';
}

// Fetch one article, re-navigating up to ARTICLE_RETRIES times if the iframe
// never renders. Always resolves to a record so indices stay aligned.
async function fetchArticle(tabId, cafeId, link) {
  const articleUrl = `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/${link.articleId}`;
  let lastError = null;

  for (let attempt = 0; attempt <= ARTICLE_RETRIES; attempt++) {
    if (batchState.aborted) break;

    const label = link.title || link.articleId;
    batchState.progress.phase = attempt === 0 ? `${label}` : `${label} (재시도 ${attempt})`;

    try {
      await navigateAndWait(tabId, articleUrl);
      await injectScript(tabId);
      const data = await collectFromTab(tabId);
      if (data) return data;
      lastError = 'article content never rendered';
    } catch (err) {
      lastError = err.message;
    }

    if (attempt < ARTICLE_RETRIES) await sleep(1000 * (attempt + 1)); // back off
  }

  batchState.result.errors.push({
    articleId: link.articleId, title: link.title, url: articleUrl,
    error: lastError || 'aborted',
  });
  return { url: articleUrl, title: link.title, body: null, author: null, date: null, comments: [] };
}

// ─── Helpers ──────────────────────────────────────────────

function buildPageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  url.searchParams.set('page', page);
  return url.toString();
}

async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  await sleep(200);
}

async function injectScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['scrapers/naver-cafe.js'],
    });
  } catch (e) { /* might fail on about:blank frames */ }
  await sleep(100);
}

async function getLinksFromTab(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const allResults = [];

  for (const frame of frames) {
    if (!frame.url.includes('cafe.naver.com')) continue;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_LINKS' }, { frameId: frame.frameId });
      if (r?.links?.length > 0) allResults.push(r);
    } catch (e) { /* skip */ }
  }

  // Return the result with most links
  if (allResults.length === 0) return [];
  allResults.sort((a, b) => b.links.length - a.links.length);
  return allResults[0].links;
}

// Poll until an article actually renders. The ca-fe iframe is created and
// filled asynchronously, so both the frame list and the DOM inside it need
// re-checking rather than a one-shot read.
async function collectFromTab(tabId) {
  const deadline = Date.now() + CONTENT_TIMEOUT;
  let partial = null;

  while (Date.now() < deadline) {
    if (batchState.aborted) break;

    // The iframe may not exist yet, so re-list frames on every pass.
    const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
    const targets = frames
      .filter(f => f.url.includes('cafe.naver.com/ca-fe/'))
      .map(f => f.frameId);
    targets.push(0); // main frame — new UI sometimes renders without the iframe

    for (const frameId of targets) {
      let r;
      try {
        r = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_DATA' }, { frameId });
      } catch (e) {
        continue; // content script not injected in this frame yet
      }
      if (!r?.title) continue;
      // Title appears before the body streams in — hold out for both.
      if (r.body) return r;
      partial = r;
    }

    await sleep(CONTENT_POLL);
  }

  // Body never arrived: a title-only post (image/video only) is still valid data.
  return partial;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === 'complete' || Date.now() - start > timeout) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      });
    };
    check();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
