# 새 플랫폼 추가 가이드

Side Collector에 새 플랫폼을 추가할 때 따르는 구현 규칙.

---

## 수집 모드 분류

| 모드 | 대상 사이트 | 수집 방식 | 출력 |
|------|------------|----------|------|
| `naver` | 네이버 카페 | 단일 페이지 파싱 + 백그라운드 일괄 | JSON |
| `review` | 쿠팡, 아이허브 | 페이지네이션 자동 클릭 | JSON |
| `social` | LinkedIn, Threads, X, YouTube, Facebook | 자동 스크롤 + DOM 수확 | CSV |

새 플랫폼은 기존 모드 중 하나에 매핑한다. 새 모드가 필요하면 panel.html에 `mode-{name}` div 추가.

---

## 체크리스트

### 1. `scrapers/{platform}.js` — Content Script

```javascript
// 필수 구조
(() => {
  if (window.__{platform}Scraper) return;  // 중복 실행 방지

  const state = {
    running: false,
    posts: new Map(),       // id -> data
    seenEls: new WeakSet(), // 처리 완료 DOM 요소
    idleScrolls: 0,
    maxIdle: 6,             // 연속 idle 후 자동 정지
    timer: null,
  };
  window.__{platform}Scraper = state;

  // ... 수집 로직 ...

  // 메시지 브릿지 (필수 5종)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START')  { /* 수집 시작 */ }
    if (msg.type === 'STOP')   { /* 수집 중지 */ }
    if (msg.type === 'STATUS') { /* { running, count, preview[] } 반환 */ }
    if (msg.type === 'CLEAR')  { /* state 초기화 */ }
    if (msg.type === 'EXPORT') { /* CSV/JSON 다운로드 */ }
  });
})();
```

**규칙:**
- `window.__` 전역 변수로 중복 실행 방지 (SPA 리마운트 대응)
- `sendResponse()` 호출 후 반드시 `return true` (비동기 응답 유지)
- STATUS의 `preview` 배열 형식: `{ author, text, is_repost, posted_date }`
- EXPORT는 content script 내에��� 직접 다운로드 (Blob → a.click)

### 2. DOM 전략 선택

| 사이트 특성 | 전략 | 예시 |
|------------|------|------|
| 정적 DOM | `querySelectorAll` 직접 파싱 | 네이버 카페, 쿠팡 |
| 무한 스크롤 (일반) | scroll + harvest 반복 | Threads, X, YouTube |
| 가상 리스트 (virtualized) | **렌더링 완료 확인 후** harvest | Facebook, LinkedIn |

**가상 리스트 대응:**
- `data-virtualized="true"` 또는 빈 placeholder 스킵
- 실제 콘텐츠(링크 2개+ 또는 텍스트 50자+) 있는 요소만 처리
- 스크롤 후 hydration 대기 (800~1200ms)
- `behavior: 'auto'` 사용 (smooth는 느림)

### 3. `manifest.json` 수정

```json
// host_permissions에 추가
"https://www.{platform}.com/*"

// content_scripts에 추가
{
  "matches": ["https://www.{platform}.com/*"],
  "js": ["scrapers/{platform}.js"],
  "run_at": "document_idle"
}
```

### 4. `panel.js` 수정

```javascript
// detectSite()에 조건 추가
if (url.includes('{platform}.com')) return '{platform}';

// showMode()에 분기 추가
} else if (site === '{platform}') {
  document.getElementById('mode-social').classList.add('active');
  badge.textContent = '{Platform}';
  badge.className = 'site-badge badge-{platform}';
  document.getElementById('btnStart').className = 'btn btn-{color}';
  setStatus('...');
}

// init()의 social polling 목록에 추가
if ([..., '{platform}'].includes(currentSite)) { pollSocialStatus(); }
```

### 5. `panel.html` 수정

```css
/* 배지 색상 */
.badge-{platform} { background: #e8f0fc; color: #0066cc; }
/* 사이트 목록 닷 */
.dot-{platform} { background: #0066cc; }
```

```html
<!-- 지원 사이트 목록에 추가 -->
<li><span class="site-dot dot-{platform}"></span>{Platform} <span class="site-desc">— 설명 (CSV)</span></li>
```

---

## 스크롤 속도 가이드라인

| 플랫폼 | 스크롤량 | 대기 | tick 간격 | 이유 |
|--------|---------|------|----------|------|
| LinkedIn | 120~1100px | 400~9000ms | 40~160ms | 봇 탐지 엄격, human-like 필수 |
| Facebook | 600~1000px | 800~1200ms | 100~250ms | 가상 리스트 hydration 필요 |
| Threads/X | 500~900px | 1000~1500ms | 200~400ms | 일반 무한 스크롤 |
| YouTube | 600~1000px | 1500~2000ms | 200~300ms | 댓글 로딩 느림 |

**원칙:** 봇 탐지 위험 높으면 느리게, 가상화 심하면 중간, 탐지 걱정 없으면 빠르게.

---

## 디버깅 패턴

새 플랫폼 추가 시 반드시 진단 코드를 먼저 작성:

```javascript
// 콘솔에서 호출: __platformDiag()
window.__platformDiag = function() {
  const containers = document.querySelectorAll('{컨테이너 셀렉터}');
  containers.forEach((el, i) => {
    if (i >= 3) return;
    console.group(`Post #${i}`);
    console.log('innerHTML length:', el.innerHTML.length);
    console.log('Links:', [...el.querySelectorAll('a[href]')].map(a => a.href.substring(0, 80)));
    console.log('Text preview:', el.textContent?.substring(0, 200));
    console.groupEnd();
  });
};
```

**단계:**
1. 진단으로 실제 DOM 구조 파악
2. 셀렉터 작성 + 테스트
3. 디버그 로그 제거 (또는 `console.debug`로 전환)

---

## 공통 유틸리티

모든 social 모드 스크래퍼가 공유하는 패턴:

```javascript
// CSV 생성 (BOM 포함)
function toCsv(rows, headers) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(','));
  return '\ufeff' + lines.join('\n');
}

// 파일 다운로드
function download(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

---

## 네이밍 컨벤션

| 항목 | 규칙 | 예시 |
|------|------|------|
| 파일명 | 소문자 하이픈 | `scrapers/new-platform.js` |
| 전역 변수 | `__` + camelCase + `Scraper` | `window.__newPlatformScraper` |
| CSS 클래스 | `.badge-{name}`, `.dot-{name}` | `.badge-reddit`, `.dot-reddit` |
| detectSite 반환값 | 소문자 단일 단어 | `'reddit'` |
| CSV 파일명 | `{platform}_{handle}_{timestamp}.csv` | `reddit_username_1714900000.csv` |
