// background.js — Service Worker: handles all tab navigation (pagination + article fetch)

// Open side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

let batchState = {
  running: false,
  aborted: false,
  progress: { current: 0, total: 0, phase: '' },
  result: null,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'BATCH_START') {
    runBatch(msg.tabId, msg.listBaseUrl, msg.startPage, msg.endPage, msg.cafeId, msg.firstPageLinks);
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

async function runBatch(tabId, listBaseUrl, startPage, endPage, cafeId, firstPageLinks) {
  batchState = {
    running: true,
    aborted: false,
    progress: { current: 0, total: 0, phase: '링크 수집 중...' },
    result: { cafeId, articles: [], errors: [] },
  };

  try {
    // ─── Phase 1: Collect links from all pages ─────────────────
    const allLinks = [...firstPageLinks];

    for (let page = startPage + 1; page <= endPage; page++) {
      if (batchState.aborted) break;

      batchState.progress.phase = `링크 수집: 페이지 ${page}/${endPage}`;

      const pageUrl = buildPageUrl(listBaseUrl, page);
      await navigateAndWait(tabId, pageUrl);
      await injectScript(tabId);
      await sleep(300);

      const links = await getLinksFromTab(tabId);
      if (links.length > 0) {
        allLinks.push(...links);
      } else {
        break; // No more pages
      }
    }

    // Deduplicate
    const unique = [...new Map(allLinks.map(l => [l.articleId, l])).values()];
    batchState.progress.total = unique.length;

    // ─── Phase 2: Fetch each article ──────────────────────────
    for (let i = 0; i < unique.length; i++) {
      if (batchState.aborted) break;

      const link = unique[i];
      batchState.progress.current = i + 1;
      batchState.progress.phase = `${link.title || link.articleId}`;

      try {
        const articleUrl = `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/${link.articleId}`;
        await navigateAndWait(tabId, articleUrl);
        await injectScript(tabId);
        await sleep(100);

        const data = await collectFromTab(tabId);
        batchState.result.articles.push(data || {
          url: articleUrl, title: link.title, body: null, author: null, date: null, comments: [],
        });
      } catch (err) {
        batchState.result.errors.push({ articleId: link.articleId, error: err.message });
      }
    }
  } catch (err) {
    batchState.result.errors.push({ phase: 'fatal', error: err.message });
  }

  batchState.running = false;
  batchState.progress.phase = 'done';
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

async function collectFromTab(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });

  // Try ca-fe iframe first (article content lives there)
  for (const frame of frames) {
    if (!frame.url.includes('cafe.naver.com/ca-fe/')) continue;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_DATA' }, { frameId: frame.frameId });
      if (r?.title) return r;
    } catch (e) { /* skip */ }
  }

  // Fallback: main frame
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_DATA' }, { frameId: 0 });
    if (r?.title) return r;
  } catch (e) { /* skip */ }

  return null;
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
