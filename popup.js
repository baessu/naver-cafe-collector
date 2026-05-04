// popup.js — Naver Cafe Collector v0.3

const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');

let lastCollected = null;
let lastOutput = '';

function setStatus(text) { statusEl.textContent = text; }
function clearOutput() { outputEl.textContent = ''; lastOutput = ''; }
function appendOutput(text) { outputEl.textContent += text + '\n'; lastOutput += text + '\n'; }

// ─── Inject + send to iframe ─────────��────────────────────

async function injectAndSend(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
  await new Promise(r => setTimeout(r, 300));

  const results = [];

  try {
    const r = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (r) results.push(r);
  } catch (e) { /* no content script */ }

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const frame of frames) {
      if (frame.frameId === 0) continue;
      if (!frame.url.includes('cafe.naver.com')) continue;
      try {
        const r = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
        if (r) results.push(r);
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* fallback */ }

  return results;
}

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('cafe.naver.com')) {
    setStatus('네이버 카페 페이지��� 아닙니다.');
    return null;
  }
  return tab;
}

// ──��� Build export data ───────────────���────────────────────

function buildExportData(data) {
  return {
    title: data.title,
    author: data.author,
    date: data.date,
    url: data.url,
    body: data.body,
    comments: data.comments.map(c => ({
      author: c.author,
      text: c.text,
      date: c.date,
      type: c.type,
      isReply: c.isReply,
    })),
    collectedAt: new Date().toISOString(),
  };
}

// ─── Build filename ────────��──────────────────────────────
// Format: YYYYMMDD_카페ID_글번호.json

function buildFilename(data) {
  // Extract cafe ID and article ID from URL
  // URL pattern: cafe.naver.com/ca-fe/cafes/{cafeId}/articles/{articleId}
  const urlMatch = data.url?.match(/cafes\/(\d+)\/articles\/(\d+)/);
  const cafeId = urlMatch?.[1] || 'unknown';
  const articleId = urlMatch?.[2] || 'unknown';

  // Date from article or current
  let dateStr;
  if (data.date) {
    // "2025.08.05. 09:59" → "20250805"
    const match = data.date.match(/(\d{4})\.(\d{2})\.(\d{2})/);
    dateStr = match ? `${match[1]}${match[2]}${match[3]}` : formatToday();
  } else {
    dateStr = formatToday();
  }

  return `${dateStr}_cafe${cafeId}_${articleId}.json`;
}

function formatToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ─���─ COLLECT ─────���────────────────────────────────────────

document.getElementById('btnCollect').addEventListener('click', async () => {
  clearOutput();
  setStatus('수집 중...');
  lastCollected = null;

  try {
    const tab = await getTab();
    if (!tab) return;

    const results = await injectAndSend(tab.id, { type: 'COLLECT_DATA' });
    const data = results.find(r => r.frameType === 'IFRAME' && r.title);

    if (!data) {
      setStatus('게시글 데이터를 찾지 못했습니다. 게시글 페이지인지 확인하세요.');
      appendOutput('[ERROR] No article data found in any frame.');
      return;
    }

    lastCollected = data;

    // Display
    appendOutput('═══════════════════════════════════════');
    appendOutput('  수집 완료');
    appendOutput('═══════════════════════════��═══════════\n');

    appendOutput(`제목: ${data.title}`);
    appendOutput(`작성자: ${data.author || '(unknown)'}`);
    appendOutput(`날짜: ${data.date || '(unknown)'}`);
    appendOutput(`URL: ${data.url}`);
    appendOutput(`파일명: ${buildFilename(data)}\n`);

    appendOutput('── 본��� ──────────────────────────────');
    appendOutput(data.body || '(본문 없���)');

    const textCount = data.comments.filter(c => c.type === 'text').length;
    const stickerCount = data.comments.filter(c => c.type === 'sticker').length;

    appendOutput(`\n── 댓글 (${data.comments.length}개) ──────────────────`);
    appendOutput(`  텍스트: ${textCount} | 스티커: ${stickerCount}\n`);

    for (const c of data.comments) {
      const prefix = c.isReply ? '  ↳ ' : '';
      if (c.type === 'sticker') {
        appendOutput(`${prefix}[${c.author}] (${c.date}) [스티커]`);
      } else if (c.type === 'empty') {
        appendOutput(`${prefix}[${c.author}] (${c.date}) [내용 없음]`);
      } else {
        appendOutput(`${prefix}[${c.author}] (${c.date})`);
        appendOutput(`${prefix}  ${c.text}`);
      }
    }

    setStatus(`수집 완료 — 제목:O 본문:${data.body ? 'O' : 'X'} 댓글:${data.comments.length}개 → [JSON 저장] 또는 [JSON 복사]`);

  } catch (err) {
    setStatus(`오류: ${err.message}`);
    appendOutput(`[ERROR] ${err.stack || err.message}`);
  }
});

// ─── SAVE JSON (download) ─────────────────────────────────

document.getElementById('btnSave').addEventListener('click', async () => {
  if (!lastCollected) {
    setStatus('���저 [수집] 버튼��로 데이터를 수집���세요.');
    return;
  }

  const exportData = buildExportData(lastCollected);
  const filename = buildFilename(lastCollected);
  const jsonStr = JSON.stringify(exportData, null, 2);

  // Create blob URL and trigger download
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: filename,
      saveAs: false,
    });
    setStatus(`저장 완료 → Downloads/${filename}`);
  } catch (err) {
    setStatus(`저장 실패: ${err.message}`);
  }
});

// ─── COPY JSON ──���─────────────────────────────────────────

document.getElementById('btnCopyJson').addEventListener('click', async () => {
  if (!lastCollected) {
    setStatus('먼저 [수집] 버튼으로 데이터를 수집하세요.');
    return;
  }

  const exportData = buildExportData(lastCollected);
  await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
  setStatus('JSON 클립보드 복사 완료!');
});

// ─── COPY TEXT ─���──────────────────────────────────────────

document.getElementById('btnCopyText').addEventListener('click', async () => {
  if (!lastOutput) {
    setStatus('먼저 [수집] ��튼으로 데이터를 수집하세요.');
    return;
  }
  await navigator.clipboard.writeText(lastOutput);
  setStatus('텍��트 클립보드 복사 완료!');
});

// ─── DEBUG: DOM ─────────────────────────────��─────────────

document.getElementById('btnDebug').addEventListener('click', async () => {
  clearOutput();
  setStatus('DOM 분석 중...');

  try {
    const tab = await getTab();
    if (!tab) return;

    const results = await injectAndSend(tab.id, { type: 'DEBUG_DOM' });

    for (const result of results) {
      appendOutput(`── ${result.frameType} ──────────────────`);
      appendOutput(`URL: ${result.url}\n`);

      if (result.iframes?.length > 0) {
        appendOutput('▸ IFRAMES:');
        for (const f of result.iframes) {
          appendOutput(`  [${f.index}] id="${f.id}" src=${f.src} (${f.width}x${f.height})`);
        }
        appendOutput('');
      }

      for (const [label, data] of Object.entries(result.selectors || {})) {
        if (data.found) {
          appendOutput(`  [OK] ${label} → <${data.tag}> "${data.text}"`);
        } else {
          appendOutput(`  [ - ] ${label}`);
        }
      }
      appendOutput('');
    }

    setStatus(`DOM 분석 완료 — ${results.length}개 프레임`);
  } catch (err) {
    setStatus(`오류: ${err.message}`);
  }
});

// ─── DEBUG: Comments ─────��────────────────────────────────

document.getElementById('btnComments').addEventListener('click', async () => {
  clearOutput();
  setStatus('댓글 구조 분석 중...');

  try {
    const tab = await getTab();
    if (!tab) return;

    const results = await injectAndSend(tab.id, { type: 'DEBUG_COMMENTS' });

    for (const result of results) {
      if (result.frameType === 'MAIN_FRAME') continue;

      appendOutput(`댓글 수: ${result.count}\n`);
      for (const c of result.first5 || []) {
        appendOutput(`  [${c.index}] ${c.type} | ${c.author} | "${c.text || c.sticker || '(empty)'}"`);
      }
    }

    setStatus('댓글 구조 분석 완료');
  } catch (err) {
    setStatus(`오류: ${err.message}`);
  }
});
