// popup.js — Naver Cafe Collector v0.6

const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');

let lastCollected = null;
let lastBatchResult = null;
let lastOutput = '';
let batchAborted = false;

function setStatus(text) { statusEl.textContent = text; }
function clearOutput() { outputEl.textContent = ''; lastOutput = ''; }
function appendOutput(text) { outputEl.textContent += text + '\n'; lastOutput += text + '\n'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildListPageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  url.searchParams.set('page', page);
  return url.toString();
}

function waitForTabLoad(tabId, timeout = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
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

// ─── Tab switching ────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Helpers ──────────────────────────────────────────────

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('cafe.naver.com')) {
    setStatus('네이버 카페 페이지가 아닙니다.');
    return null;
  }
  return tab;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
  await sleep(200);
}

async function sendToContent(tabId, message) {
  const results = [];

  // Collect from all frames
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  for (const frame of frames) {
    if (!frame.url.includes('cafe.naver.com')) continue;
    try {
      const r = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
      if (r) results.push(r);
    } catch (e) { /* skip */ }
  }

  if (results.length === 0) return null;

  // For GET_LINKS: prefer result with most links
  if (message.type === 'GET_LINKS') {
    const withLinks = results.filter(r => r.links?.length > 0);
    if (withLinks.length > 0) {
      return withLinks.sort((a, b) => b.links.length - a.links.length)[0];
    }
  }

  // For COLLECT_DATA: prefer result with title
  if (message.type === 'COLLECT_DATA') {
    const withTitle = results.find(r => r.title);
    if (withTitle) return withTitle;
  }

  return results[0];
}

async function sendToMain(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (e) { return null; }
}

// ─── Filename helpers ─────────────────────────────────────

function formatToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function buildSingleFilename(data) {
  const urlMatch = data.url?.match(/cafes\/(\d+)\/articles\/(\d+)/);
  const cafeId = urlMatch?.[1] || 'unknown';
  const articleId = urlMatch?.[2] || 'unknown';
  return `${formatToday()}_cafe${cafeId}_${articleId}.json`;
}

function buildBatchFilename(data) {
  const cafeId = data.cafeId || 'unknown';
  return `${formatToday()}_cafe${cafeId}_batch_${data.articles.length}articles.json`;
}

function buildExportData(data) {
  return {
    title: data.title,
    author: data.author,
    date: data.date,
    url: data.url,
    body: data.body,
    comments: (data.comments || []).map(c => ({
      author: c.author, text: c.text, date: c.date, type: c.type, isReply: c.isReply,
    })),
    collectedAt: new Date().toISOString(),
  };
}

function buildBatchExportData(result) {
  return {
    cafeId: result.cafeId,
    totalArticles: result.articles.length,
    collectedAt: new Date().toISOString(),
    articles: result.articles.map(a => ({
      title: a.title,
      author: a.author,
      date: a.date,
      url: a.url,
      body: a.body,
      comments: (a.comments || []).map(c => ({
        author: c.author, text: c.text, date: c.date, type: c.type, isReply: c.isReply,
      })),
    })),
  };
}

async function downloadJson(jsonStr, filename) {
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
    setStatus(`저장 완료 → Downloads/${filename}`);
  } catch (err) {
    setStatus(`저장 실패: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  SINGLE COLLECT
// ═══════════════════════════════════════════════════════════

document.getElementById('btnCollect').addEventListener('click', async () => {
  clearOutput();
  setStatus('수집 중...');
  lastCollected = null;

  const tab = await getTab();
  if (!tab) return;

  await inject(tab.id);
  const data = await sendToContent(tab.id, { type: 'COLLECT_DATA' });

  if (!data || !data.title) {
    setStatus('게시글 데이터를 찾지 못했습니다.');
    return;
  }

  lastCollected = data;
  appendOutput(`제목: ${data.title}`);
  appendOutput(`작성자: ${data.author || '-'} | 날짜: ${data.date || '-'}`);
  appendOutput(`URL: ${data.url}\n`);
  appendOutput('── 본문 ──────────────────────────────');
  appendOutput(data.body || '(본문 없음)');
  const textCount = data.comments.filter(c => c.type === 'text').length;
  appendOutput(`\n── 댓글 (${data.comments.length}개, 텍스트 ${textCount}) ──`);
  for (const c of data.comments) {
    const prefix = c.isReply ? '  ↳ ' : '';
    appendOutput(`${prefix}[${c.author}] (${c.date}) ${c.type === 'sticker' ? '[스티커]' : c.text}`);
  }
  setStatus(`수집 완료 — 본문:${data.body ? 'O' : 'X'} 댓글:${data.comments.length}개`);
});

document.getElementById('btnSave').addEventListener('click', async () => {
  if (!lastCollected) { setStatus('먼저 [수집]하세요.'); return; }
  await downloadJson(JSON.stringify(buildExportData(lastCollected), null, 2), buildSingleFilename(lastCollected));
});

document.getElementById('btnCopyJson').addEventListener('click', async () => {
  if (!lastCollected) { setStatus('먼저 [수집]하세요.'); return; }
  await navigator.clipboard.writeText(JSON.stringify(buildExportData(lastCollected), null, 2));
  setStatus('JSON 복사 완료!');
});

document.getElementById('btnCopyText').addEventListener('click', async () => {
  if (!lastOutput) { setStatus('먼저 [수집]하세요.'); return; }
  await navigator.clipboard.writeText(lastOutput);
  setStatus('텍스트 복사 완료!');
});

// ═══════════════════════════════════════════════════════════
//  BATCH COLLECT — Delegates to background service worker
// ═══════════════════════════════════════════════════════════

document.getElementById('btnBatch').addEventListener('click', async () => {
  clearOutput();
  lastBatchResult = null;

  const startPage = parseInt(document.getElementById('startPage').value) || 1;
  const endPage = parseInt(document.getElementById('endPage').value) || 3;

  if (endPage < startPage) { setStatus('끝 페이지가 시작보다 작습니다.'); return; }

  const tab = await getTab();
  if (!tab) return;

  const btnBatch = document.getElementById('btnBatch');
  const btnStop = document.getElementById('btnBatchStop');
  const progressBar = document.getElementById('progress');
  const progressFill = document.querySelector('#progress .fill');

  appendOutput(`═══════════════════════════════════════`);
  appendOutput(`  일괄 수집: 페이지 ${startPage} ~ ${endPage}`);
  appendOutput(`═══════════════════════════════════════\n`);

  // Step 1: Collect links from current page only (no tab navigation in popup)
  setStatus('링크 수집 중...');
  await inject(tab.id);
  await sleep(300);
  const firstResult = await sendToContent(tab.id, { type: 'GET_LINKS' });

  if (!firstResult?.links?.length) {
    setStatus('글 목록을 찾지 못했습니다. 게시판/멤버 페이지인지 확인하세요.');
    return;
  }

  const cafeId = firstResult.cafeId || '';
  const listBaseUrl = firstResult.pageUrl;

  appendOutput(`현재 페이지: ${firstResult.links.length}개 링크 발견`);
  appendOutput(`페이지 ${startPage}~${endPage} 수집을 백그라운드에서 실행합니다.`);
  appendOutput(`\n팝업을 닫아도 수집이 계속됩니다.`);
  appendOutput(`다시 팝업을 열면 진행 상태를 확인할 수 있습니다.\n`);

  // Send everything to background — it handles pagination + article fetch
  btnBatch.disabled = true;
  btnStop.style.display = '';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  chrome.runtime.sendMessage({
    type: 'BATCH_START',
    tabId: tab.id,
    listBaseUrl,
    startPage,
    endPage,
    cafeId,
    firstPageLinks: firstResult.links,
  });

  setStatus(`백그라운드 수집 시작`);

  // Start polling for progress
  startProgressPolling();
});

let pollInterval = null;

function startProgressPolling() {
  if (pollInterval) clearInterval(pollInterval);

  const progressFill = document.querySelector('#progress .fill');
  const progressBar = document.getElementById('progress');
  const btnBatch = document.getElementById('btnBatch');
  const btnStop = document.getElementById('btnBatchStop');

  progressBar.style.display = 'block';
  btnBatch.disabled = true;
  btnStop.style.display = '';

  pollInterval = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'BATCH_STATUS' });

    if (!status || !status.running) {
      clearInterval(pollInterval);
      pollInterval = null;
      btnBatch.disabled = false;
      btnStop.style.display = 'none';

      if (status?.result) {
        lastBatchResult = status.result;
        progressFill.style.width = '100%';

        const totalComments = status.result.articles.reduce((s, a) => s + (a.comments?.length || 0), 0);
        clearOutput();
        appendOutput(`═══════════════════════════════════════`);
        appendOutput(`  수집 완료`);
        appendOutput(`═══════════════════════════════════════\n`);

        for (let i = 0; i < status.result.articles.length; i++) {
          const a = status.result.articles[i];
          appendOutput(`[${i + 1}] ${a.title || '(제목 없음)'}`);
          appendOutput(`    ${a.author || '-'} | ${a.date || '-'} | 댓글 ${a.comments?.length || 0}개`);
        }

        if (status.result.errors?.length > 0) {
          appendOutput(`\n오류 ${status.result.errors.length}개:`);
          status.result.errors.forEach(e => appendOutput(`  ${e.articleId}: ${e.error}`));
        }

        appendOutput(`\n══════════════════════════════════════`);
        appendOutput(`  ${status.result.articles.length}개 글, ${totalComments}개 댓글`);
        appendOutput(`══════════════════════════════════════`);
        setStatus(`일괄 수집 완료 — ${status.result.articles.length}개 글, ${totalComments}개 댓글 → [JSON 저장] 또는 [JSON 복사]`);
      } else {
        setStatus('수집이 완료되었지만 결과를 가져오지 못했습니다.');
      }
      return;
    }

    // Update progress
    const pct = status.progress.total > 0
      ? Math.round((status.progress.current / status.progress.total) * 100)
      : 0;
    progressFill.style.width = `${pct}%`;
    const progressTextEl = document.getElementById('progressText');
    if (progressTextEl) progressTextEl.textContent = `${status.progress.current}/${status.progress.total} — ${status.progress.phase}`;
    setStatus(`수집 중... ${status.progress.current}/${status.progress.total} (${pct}%)`);
  }, 1000);
}

// On popup open, check if batch is already running
(async () => {
  const status = await chrome.runtime.sendMessage({ type: 'BATCH_STATUS' });
  if (status?.running) {
    // Switch to batch tab and start polling
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="batch"]').classList.add('active');
    document.getElementById('panel-batch').classList.add('active');
    appendOutput('백그라운드 수집 진행 중...\n');
    startProgressPolling();
  }
})();

// Stop button
document.getElementById('btnBatchStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BATCH_STOP' });
  setStatus('중지 요청됨...');
});

// Batch save/copy
document.getElementById('btnBatchSave').addEventListener('click', async () => {
  if (!lastBatchResult) { setStatus('먼저 수집을 완료하세요.'); return; }
  const json = JSON.stringify(buildBatchExportData(lastBatchResult), null, 2);
  await downloadJson(json, buildBatchFilename(lastBatchResult));
});

document.getElementById('btnBatchCopy').addEventListener('click', async () => {
  if (!lastBatchResult) { setStatus('먼저 수집을 완료하세요.'); return; }
  await navigator.clipboard.writeText(JSON.stringify(buildBatchExportData(lastBatchResult), null, 2));
  setStatus('JSON 복사 완료!');
});

