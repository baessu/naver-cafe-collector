// panel.js — Side Collector v2.0
// Unified panel: auto-detects site and shows appropriate UI

const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');

let currentSite = null;
let lastCollected = null;
let lastBatchResult = null;
let lastOutput = '';
let socialPollInterval = null;

function setStatus(text) { statusEl.textContent = text; }
function clearOutput() { outputEl.textContent = ''; lastOutput = ''; }
function appendOutput(text) { outputEl.textContent += text + '\n'; lastOutput += text + '\n'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
//  SITE DETECTION
// ═══════════════════════════════════════════════════════════

function detectSite(url) {
  if (url.includes('cafe.naver.com')) return 'naver';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('threads.net') || url.includes('threads.com')) return 'threads';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'x';
  return null;
}

function showMode(site) {
  currentSite = site;
  document.querySelectorAll('.mode').forEach(m => m.classList.remove('active'));

  const badge = document.getElementById('siteBadge');

  if (site === 'naver') {
    document.getElementById('mode-naver').classList.add('active');
    badge.textContent = 'Naver Cafe';
    badge.className = 'site-badge badge-naver';
    setStatus('네이버 카페 페이지에서 수집을 시작하세요.');
  } else if (site === 'linkedin') {
    document.getElementById('mode-social').classList.add('active');
    badge.textContent = 'LinkedIn';
    badge.className = 'site-badge badge-linkedin';
    document.getElementById('btnStart').className = 'btn btn-linkedin';
    setStatus('프로필 활동 페이지에서 Start를 누르세요.');
  } else if (site === 'threads') {
    document.getElementById('mode-social').classList.add('active');
    badge.textContent = 'Threads';
    badge.className = 'site-badge badge-threads';
    document.getElementById('btnStart').className = 'btn btn-dark';
    setStatus('프로필 페이지에서 Start를 누르세요.');
  } else if (site === 'x') {
    document.getElementById('mode-social').classList.add('active');
    badge.textContent = 'X';
    badge.className = 'site-badge badge-x';
    document.getElementById('btnStart').className = 'btn btn-dark';
    setStatus('프로필 페이지에서 Start를 누르세요.');
  } else {
    document.getElementById('mode-unsupported').classList.add('active');
    badge.textContent = '—';
    badge.className = 'site-badge badge-unknown';
    setStatus('지원되지 않는 사이트입니다.');
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) showMode(detectSite(tab.url));

  if (currentSite === 'naver') {
    const status = await chrome.runtime.sendMessage({ type: 'BATCH_STATUS' });
    if (status?.running) {
      switchNaverTab('batch');
      startNaverProgressPolling();
    }
  }
  if (['linkedin', 'threads', 'x'].includes(currentSite)) {
    pollSocialStatus();
  }
}

init();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      if (activeTab?.id === tabId && activeTab.url) {
        const newSite = detectSite(activeTab.url);
        if (newSite !== currentSite) showMode(newSite);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  NAVER CAFE — Helpers
// ═══════════════════════════════════════════════════════════

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['scrapers/naver-cafe.js'] });
  await sleep(200);
}

async function sendToContent(tabId, message) {
  const results = [];
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  for (const frame of frames) {
    if (!frame.url.includes('cafe.naver.com')) continue;
    try {
      const r = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
      if (r) results.push(r);
    } catch (e) { /* skip */ }
  }
  if (results.length === 0) return null;
  if (message.type === 'GET_LINKS') {
    const withLinks = results.filter(r => r.links?.length > 0);
    if (withLinks.length > 0) return withLinks.sort((a, b) => b.links.length - a.links.length)[0];
  }
  if (message.type === 'COLLECT_DATA') {
    const withTitle = results.find(r => r.title);
    if (withTitle) return withTitle;
  }
  return results[0];
}

function formatToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function buildExportData(data) {
  return {
    title: data.title, author: data.author, date: data.date, url: data.url, body: data.body,
    comments: (data.comments || []).map(c => ({ author: c.author, text: c.text, date: c.date, type: c.type, isReply: c.isReply })),
    collectedAt: new Date().toISOString(),
  };
}

function buildBatchExportData(result) {
  return {
    cafeId: result.cafeId, totalArticles: result.articles.length, collectedAt: new Date().toISOString(),
    articles: result.articles.map(a => ({
      title: a.title, author: a.author, date: a.date, url: a.url, body: a.body,
      comments: (a.comments || []).map(c => ({ author: c.author, text: c.text, date: c.date, type: c.type, isReply: c.isReply })),
    })),
  };
}

async function downloadJson(jsonStr, filename) {
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename, saveAs: false }); setStatus(`저장 완료 → ${filename}`); }
  catch (err) { setStatus(`저장 실패: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════
//  NAVER CAFE — Tab switching
// ═══════════════════════════════════════════════════════════

function switchNaverTab(tabName) {
  document.querySelectorAll('#mode-naver .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#mode-naver .panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`#mode-naver [data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`panel-${tabName}`).classList.add('active');
}

document.querySelectorAll('#mode-naver .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchNaverTab(btn.dataset.tab));
});

// ═══════════════════════════════════════════════════════════
//  NAVER CAFE — Single collect
// ═══════════════════════════════════════════════════════════

document.getElementById('btnCollect').addEventListener('click', async () => {
  clearOutput();
  setStatus('수집 중...');
  lastCollected = null;
  const tab = await getTab();
  if (!tab) return;
  await inject(tab.id);
  const data = await sendToContent(tab.id, { type: 'COLLECT_DATA' });
  if (!data || !data.title) { setStatus('게시글 데이터를 찾지 못했습니다.'); return; }
  lastCollected = data;
  appendOutput(`제목: ${data.title}`);
  appendOutput(`작성자: ${data.author || '-'} | 날짜: ${data.date || '-'}\n`);
  appendOutput('── 본문 ──────────────────────────────');
  appendOutput(data.body || '(본문 없음)');
  appendOutput(`\n── 댓글 (${data.comments.length}개) ──────────────────`);
  for (const c of data.comments) {
    const prefix = c.isReply ? '  ↳ ' : '';
    appendOutput(`${prefix}[${c.author}] (${c.date}) ${c.type === 'sticker' ? '[스티커]' : c.text}`);
  }
  setStatus(`수집 완료 — 본문:${data.body ? 'O' : 'X'} 댓글:${data.comments.length}개`);
});

document.getElementById('btnSave').addEventListener('click', async () => {
  if (!lastCollected) { setStatus('먼저 수집하세요.'); return; }
  const m = lastCollected.url?.match(/cafes\/(\d+)\/articles\/(\d+)/);
  await downloadJson(JSON.stringify(buildExportData(lastCollected), null, 2), `${formatToday()}_cafe${m?.[1] || 'x'}_${m?.[2] || 'x'}.json`);
});

document.getElementById('btnCopyJson').addEventListener('click', async () => {
  if (!lastCollected) { setStatus('먼저 수집하세요.'); return; }
  await navigator.clipboard.writeText(JSON.stringify(buildExportData(lastCollected), null, 2));
  setStatus('JSON 복사 완료!');
});

document.getElementById('btnCopyText').addEventListener('click', async () => {
  if (!lastOutput) { setStatus('먼저 수집하세요.'); return; }
  await navigator.clipboard.writeText(lastOutput);
  setStatus('텍스트 복사 완료!');
});

// ═══════════════════════════════════════════════════════════
//  NAVER CAFE — Batch collect
// ═══════════════════════════════════════════════════════════

document.getElementById('btnBatch').addEventListener('click', async () => {
  clearOutput();
  lastBatchResult = null;
  const startPage = parseInt(document.getElementById('startPage').value) || 1;
  const endPage = parseInt(document.getElementById('endPage').value) || 3;
  if (endPage < startPage) { setStatus('끝 페이지가 시작보다 작습니다.'); return; }

  const tab = await getTab();
  if (!tab) return;

  setStatus('링크 수집 중...');
  await inject(tab.id);
  await sleep(300);
  const firstResult = await sendToContent(tab.id, { type: 'GET_LINKS' });
  if (!firstResult?.links?.length) { setStatus('글 목록을 찾지 못했습니다.'); return; }

  appendOutput(`${firstResult.links.length}개 링크 발견 — 백그라운드 수집 시작`);

  document.getElementById('btnBatch').disabled = true;
  document.getElementById('btnBatchStop').style.display = '';
  document.getElementById('progress').style.display = 'block';

  chrome.runtime.sendMessage({
    type: 'BATCH_START',
    tabId: tab.id,
    listBaseUrl: firstResult.pageUrl,
    startPage,
    endPage,
    cafeId: firstResult.cafeId || '',
    firstPageLinks: firstResult.links,
  });

  startNaverProgressPolling();
});

let naverPollInterval = null;

function startNaverProgressPolling() {
  if (naverPollInterval) clearInterval(naverPollInterval);
  const progressFill = document.querySelector('#progress .fill');

  naverPollInterval = setInterval(async () => {
    const s = await chrome.runtime.sendMessage({ type: 'BATCH_STATUS' });
    if (!s || !s.running) {
      clearInterval(naverPollInterval);
      naverPollInterval = null;
      document.getElementById('btnBatch').disabled = false;
      document.getElementById('btnBatchStop').style.display = 'none';
      if (s?.result) {
        lastBatchResult = s.result;
        progressFill.style.width = '100%';
        const total = s.result.articles.length;
        const comments = s.result.articles.reduce((sum, a) => sum + (a.comments?.length || 0), 0);
        clearOutput();
        for (let i = 0; i < total; i++) {
          const a = s.result.articles[i];
          appendOutput(`[${i + 1}] ${a.title || '(제목 없음)'} — 댓글 ${a.comments?.length || 0}개`);
        }
        setStatus(`완료 — ${total}개 글, ${comments}개 댓글`);
      }
      return;
    }
    const pct = s.progress.total > 0 ? Math.round((s.progress.current / s.progress.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    document.getElementById('progressText').textContent = `${s.progress.current}/${s.progress.total} — ${s.progress.phase}`;
    setStatus(`수집 중... ${s.progress.current}/${s.progress.total} (${pct}%)`);
  }, 1000);
}

document.getElementById('btnBatchStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BATCH_STOP' });
  setStatus('중지 요청됨...');
});

document.getElementById('btnBatchSave').addEventListener('click', async () => {
  if (!lastBatchResult) { setStatus('먼저 수집을 완료하세요.'); return; }
  const filename = `${formatToday()}_cafe${lastBatchResult.cafeId}_batch_${lastBatchResult.articles.length}.json`;
  await downloadJson(JSON.stringify(buildBatchExportData(lastBatchResult), null, 2), filename);
});

document.getElementById('btnBatchCopy').addEventListener('click', async () => {
  if (!lastBatchResult) { setStatus('먼저 수집을 완료하세요.'); return; }
  await navigator.clipboard.writeText(JSON.stringify(buildBatchExportData(lastBatchResult), null, 2));
  setStatus('JSON 복사 완료!');
});

// ═══════════════════════════════════════════════════════════
//  SOCIAL MODE (LinkedIn, Threads, X)
// ═══════════════════════════════════════════════════════════

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, message); }
  catch (e) { return null; }
}

document.getElementById('btnStart').addEventListener('click', async () => {
  const r = await sendToActiveTab({ type: 'START' });
  if (r?.ok) {
    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display = '';
    setStatus('스크롤 수집 중...');
    startSocialPolling();
  } else {
    setStatus('시작 실패 — 프로필 페이지인지 확인하세요.');
  }
});

document.getElementById('btnStop').addEventListener('click', async () => {
  await sendToActiveTab({ type: 'STOP' });
  document.getElementById('btnStart').style.display = '';
  document.getElementById('btnStop').style.display = 'none';
  stopSocialPolling();
  setStatus('수집 중지됨');
});

document.getElementById('btnExport').addEventListener('click', async () => {
  const r = await sendToActiveTab({ type: 'EXPORT' });
  if (r?.ok) setStatus(`CSV 내보내기 완료 — ${r.count}개 게시물`);
  else setStatus('내보내기 실패');
});

document.getElementById('btnClear').addEventListener('click', async () => {
  await sendToActiveTab({ type: 'CLEAR' });
  document.getElementById('postCount').textContent = '0';
  document.getElementById('preview').innerHTML = '';
  setStatus('초기화 완료');
});

function startSocialPolling() {
  if (socialPollInterval) clearInterval(socialPollInterval);
  socialPollInterval = setInterval(pollSocialStatus, 1500);
}

function stopSocialPolling() {
  if (socialPollInterval) { clearInterval(socialPollInterval); socialPollInterval = null; }
}

async function pollSocialStatus() {
  const r = await sendToActiveTab({ type: 'STATUS' });
  if (!r) return;

  document.getElementById('postCount').textContent = r.count || 0;

  if (r.running) {
    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display = '';
    if (!socialPollInterval) startSocialPolling();
  } else {
    document.getElementById('btnStart').style.display = '';
    document.getElementById('btnStop').style.display = 'none';
    stopSocialPolling();
  }

  const previewEl = document.getElementById('preview');
  if (r.preview?.length > 0) {
    previewEl.innerHTML = r.preview.map(p => `
      <div class="preview-item">
        <div class="author">${escHtml(p.author || '')}${p.is_repost ? ' (repost)' : ''}</div>
        <div class="text">${escHtml((p.text || '').substring(0, 150))}</div>
        <div class="meta">${p.posted_date || ''}</div>
      </div>
    `).join('');
  }
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
