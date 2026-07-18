// content.js — 쿠팡 리뷰 수집 (디버깅 모드)
// 콘솔(F12)에서 [CRC] 태그로 모든 동작을 추적할 수 있다.

(() => {
  const DEBUG = true;
  const TAG = "[CRC]";

  function log(...args) {
    if (DEBUG) console.log(TAG, ...args);
  }
  function warn(...args) {
    if (DEBUG) console.warn(TAG, ...args);
  }
  function logGroup(label) {
    if (DEBUG) console.group(`${TAG} ${label}`);
  }
  function logGroupEnd() {
    if (DEBUG) console.groupEnd();
  }

  let collectedReviews = [];
  let currentPage = 0;
  let totalPages = 0;
  let isCollecting = false;
  let aborted = false;

  // panel.js로부터 메시지 수신
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startCollect" && !isCollecting) {
      log("=== 수집 시작 명령 수신 ===");
      isCollecting = true;
      aborted = false;
      collectedReviews = [];
      currentPage = 0;
      startCollection();
    }
    if (msg.action === "stopCollect") {
      log("=== 수집 중단 명령 수신 ===");
      aborted = true;
      sendResponse({ ok: true, count: collectedReviews.length });
      return true;
    }
  });

  // 페이지 로드 시 기본 정보 출력
  log("content.js 로드됨");
  log("URL:", window.location.href);
  dumpPageStructure();

  function dumpPageStructure() {
    logGroup("📋 페이지 구조 스냅샷");

    // 리뷰 탭 후보 탐색
    const tabCandidates = [
      "li.tab-titles__tab a[href*='btfReview']",
      "a[href*='btfReview']",
      "li[data-tab='btfReview']",
      "a[href*='review']",
      "a[href*='Review']",
      "button:has-text('리뷰')",
    ];
    log("🔍 리뷰 탭 탐색:");
    tabCandidates.forEach((sel) => {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) log(`  ✅ ${sel} → ${els.length}개`, els[0].textContent.trim().slice(0, 50));
        else log(`  ❌ ${sel} → 없음`);
      } catch (e) {
        log(`  ⚠️ ${sel} → 에러: ${e.message}`);
      }
    });

    // 리뷰 영역 후보 탐색
    const sectionCandidates = [
      ".sdp-review",
      "#btfTab",
      ".js_reviewArticleListArea",
      ".sdp-review__article__list",
      "[class*='review'][class*='article']",
      "[class*='review'][class*='list']",
    ];
    log("🔍 리뷰 섹션 탐색:");
    sectionCandidates.forEach((sel) => {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) {
          log(`  ✅ ${sel} → ${els.length}개`);
          // 첫 번째 요소의 클래스 목록
          log(`     classes: ${els[0].className}`);
        } else {
          log(`  ❌ ${sel} → 없음`);
        }
      } catch (e) {
        log(`  ⚠️ ${sel} → 에러: ${e.message}`);
      }
    });

    // 핵심: sdp-review__article__list__help (도움이 돼요) 의 부모 = 리뷰 아이템
    log("🔍 리뷰 아이템 역추적 (도움이 돼요 버튼의 부모 탐색):");
    const helpBtns = document.querySelectorAll(".sdp-review__article__list__help, .js_reviewArticleHelpfulContainer");
    if (helpBtns.length) {
      log(`  도움이 돼요 버튼: ${helpBtns.length}개`);
      const parent = helpBtns[0].parentElement;
      if (parent) {
        log(`  부모 태그: <${parent.tagName.toLowerCase()}>`);
        log(`  부모 class: "${parent.className}"`);
        log(`  부모 id: "${parent.id}"`);
        log(`  부모 outerHTML (2000자):`, parent.outerHTML.slice(0, 2000));
        const grandparent = parent.parentElement;
        if (grandparent) {
          log(`  조부모 태그: <${grandparent.tagName.toLowerCase()}>`);
          log(`  조부모 class: "${grandparent.className}"`);
          log(`  조부모 자식 수: ${grandparent.children.length}`);
          // 조부모의 자식들(=리뷰 아이템 목록) 클래스 패턴
          Array.from(grandparent.children).slice(0, 3).forEach((child, i) => {
            log(`    자식[${i}] <${child.tagName.toLowerCase()}> class="${child.className}" (children: ${child.children.length})`);
          });
        }
      }
    } else {
      log("  도움이 돼요 버튼 없음 — .sdp-review 직접 덤프:");
      const sdpReview = document.querySelector(".sdp-review");
      if (sdpReview) {
        log("  .sdp-review outerHTML (3000자):", sdpReview.outerHTML.slice(0, 3000));
      }
    }

    // 리뷰 아이템 후보 탐색
    const articleCandidates = [
      ".sdp-review__article__list__review",
      ".js_reviewArticleReviewList article",
      ".sdp-review__article__list > article",
      "article.sdp-review__article__list__review",
      "article[class*='review']",
      ".sdp-review > div > div",  // 일반적 중첩 구조
      ".sdp-review__article__list__help",  // 도움 버튼 자체 (부모 접근용)
    ];
    log("🔍 리뷰 아이템 탐색:");
    articleCandidates.forEach((sel) => {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) {
          log(`  ✅ ${sel} → ${els.length}개`);
          // 첫 번째 아이템 내부 구조 덤프
          const first = els[0];
          log(`     innerHTML 미리보기 (500자):`, first.innerHTML.slice(0, 500));
          log(`     자식 요소 수:`, first.children.length);
          Array.from(first.children).forEach((child, i) => {
            log(`       [${i}] <${child.tagName.toLowerCase()}> class="${child.className}" text="${child.textContent.trim().slice(0, 60)}"`);
          });
        } else {
          log(`  ❌ ${sel} → 없음`);
        }
      } catch (e) {
        log(`  ⚠️ ${sel} → 에러: ${e.message}`);
      }
    });

    // 페이지네이션 후보 탐색
    const pageCandidates = [
      ".sdp-review__article__page",
      ".js_reviewArticlePageArea",
      "[class*='review'][class*='page']",
      "[class*='pagination']",
      ".sdp-review button[class*='page']",
      ".sdp-review [class*='page']",
    ];

    // sdp-review 내부에서 button/a 전체 탐색 (페이지네이션 발견 보조)
    const sdpReview = document.querySelector(".sdp-review");
    if (sdpReview) {
      const allBtns = sdpReview.querySelectorAll("button, a[href]");
      const pagelike = Array.from(allBtns).filter((b) => /^\d+$/.test(b.textContent.trim()));
      if (pagelike.length) {
        log(`🔍 .sdp-review 내 숫자 버튼: ${pagelike.length}개`);
        pagelike.slice(0, 5).forEach((b, i) => {
          log(`  [${i}] <${b.tagName.toLowerCase()}> class="${b.className}" text="${b.textContent.trim()}"`);
        });
      }
    }
    log("🔍 페이지네이션 탐색:");
    pageCandidates.forEach((sel) => {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) {
          log(`  ✅ ${sel} → ${els.length}개`);
          log(`     innerHTML:`, els[0].innerHTML.slice(0, 300));
        } else {
          log(`  ❌ ${sel} → 없음`);
        }
      } catch (e) {
        log(`  ⚠️ ${sel} → 에러: ${e.message}`);
      }
    });

    // review 관련 클래스 전체 스캔
    log("🔍 'review' 포함 클래스 전체 스캔:");
    const allEls = document.querySelectorAll("[class*='review'], [class*='Review']");
    const classSet = new Set();
    allEls.forEach((el) => {
      el.className.split(/\s+/).forEach((cls) => {
        if (/review/i.test(cls)) classSet.add(cls);
      });
    });
    log(`  총 ${classSet.size}개 고유 클래스:`, [...classSet].sort().join(", "));

    logGroupEnd();
  }

  async function startCollection() {
    try {
      sendProgress("리뷰 섹션으로 이동 중...", 0);

      // 1. 리뷰 탭으로 스크롤/클릭
      logGroup("Phase 1: 리뷰 섹션 이동");
      const scrolledToReviews = await scrollToReviewSection();
      logGroupEnd();

      if (!scrolledToReviews) {
        warn("리뷰 섹션 못 찾음 — DOM 스냅샷을 콘솔에서 확인하세요");
        // 못 찾아도 일단 계속 시도
        log("리뷰 섹션 없이 현재 페이지에서 수집 시도...");
      }

      await sleep(2000);

      // 이동 후 DOM 재스캔
      log("=== 리뷰 탭 클릭 후 DOM 재스캔 ===");
      dumpPageStructure();

      // 2. 총 페이지 수 파악
      logGroup("Phase 2: 페이지네이션 감지");
      totalPages = detectTotalPages();
      log(`감지된 총 페이지 수: ${totalPages}`);
      logGroupEnd();

      sendProgress(`총 ${totalPages}페이지 감지됨. 수집 시작...`, 5);

      // 3. 수집 시작
      logGroup("Phase 3: 리뷰 수집");
      await collectAllPages();
      logGroupEnd();

    } catch (err) {
      warn("수집 중 에러:", err);
      sendError(`수집 중 오류: ${err.message}`);
    }
  }

  async function scrollToReviewSection() {
    const tabSelectors = [
      "li.tab-titles__tab a[href*='btfReview']",
      "a[href*='btfReview']",
      "li[data-tab='btfReview']",
      "a[href*='review']",
      "a[href*='Review']",
    ];

    for (const sel of tabSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        log(`리뷰 탭 클릭: ${sel} → "${el.textContent.trim().slice(0, 30)}"`);
        el.click();
        await sleep(1000);
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        await sleep(1000);
        return true;
      }
    }

    // 탭 못 찾으면 리뷰 영역으로 직접 스크롤
    const sectionSelectors = [
      ".sdp-review",
      "#btfTab",
      ".js_reviewArticleListArea",
      ".sdp-review__article__list",
    ];

    for (const sel of sectionSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        log(`리뷰 섹션으로 스크롤: ${sel}`);
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        await sleep(1000);
        return true;
      }
    }

    return false;
  }

  function getPageButtons() {
    // .sdp-review 내부에서 숫자 버튼들을 찾는다
    const sdpReview = document.querySelector(".sdp-review");
    if (!sdpReview) return [];

    const allBtns = sdpReview.querySelectorAll("button");
    return Array.from(allBtns).filter((btn) => {
      const text = btn.textContent.trim();
      return /^\d+$/.test(text);
    });
  }

  function getActivePageNum() {
    const btns = getPageButtons();
    for (const btn of btns) {
      // 활성 버튼은 보통 border/text 색상이 다름 — 여러 패턴 대응
      const cls = btn.className;
      if (
        cls.includes("twc-border-[#346aff]") ||
        cls.includes("twc-text-[#346aff]") ||
        cls.includes("twc-font-bold") ||
        btn.getAttribute("aria-current") === "true" ||
        btn.getAttribute("aria-selected") === "true"
      ) {
        return parseInt(btn.textContent.trim());
      }
    }
    // 폴백: 못 찾으면 currentPage 사용
    return currentPage || 1;
  }

  function detectTotalPages() {
    const btns = getPageButtons();
    if (btns.length === 0) {
      log("페이지 버튼 없음 — 단일 페이지로 간주");
      return 1;
    }

    let maxPage = 1;
    btns.forEach((btn) => {
      const num = parseInt(btn.textContent.trim());
      if (num > maxPage) maxPage = num;
    });

    // "다음" 화살표 버튼이 있으면 더 많은 페이지 존재
    const sdpReview = document.querySelector(".sdp-review");
    if (sdpReview) {
      const svgBtns = sdpReview.querySelectorAll("button");
      for (const btn of svgBtns) {
        if (btn.querySelector("svg") && !btn.textContent.trim()) {
          // SVG만 있는 버튼 = 화살표 (다음/이전)
          log(`화살표 버튼 발견 — ${maxPage}+ 페이지 이상 추정`);
          maxPage = Math.max(maxPage, maxPage + 5);
          break;
        }
      }
    }

    log(`감지된 페이지 버튼: ${btns.length}개, 최대: ${maxPage}`);
    return maxPage;
  }

  async function collectAllPages() {
    let consecutiveEmpty = 0;

    while (true) {
      if (aborted) {
        log("사용자 중단 요청 → 수집 종료");
        break;
      }

      currentPage++;
      const progress = totalPages > 0 ? Math.min((currentPage / totalPages) * 100, 95) : 0;
      sendProgress(`${currentPage}페이지 수집 중...`, progress, currentPage);

      logGroup(`📄 Page ${currentPage}`);

      const reviews = parseCurrentPageReviews();
      log(`파싱 결과: ${reviews.length}개 리뷰`);

      if (reviews.length === 0) {
        consecutiveEmpty++;
        warn(`빈 페이지 (연속 ${consecutiveEmpty}회)`);
        if (consecutiveEmpty >= 2) {
          log("2페이지 연속 빈 결과 → 수집 종료");
          logGroupEnd();
          break;
        }
      } else {
        consecutiveEmpty = 0;
        collectedReviews.push(...reviews);
        log(`누적 리뷰: ${collectedReviews.length}개`);
      }

      logGroupEnd();

      sendProgress(`${currentPage}페이지 완료 (총 ${collectedReviews.length}개)`, progress, currentPage);

      if (aborted) {
        log("사용자 중단 요청 → 수집 종료");
        break;
      }

      const hasNext = await goToNextPage();
      if (!hasNext) {
        log("다음 페이지 없음 → 수집 종료");
        break;
      }

      await sleep(1200 + Math.random() * 800);
    }

    log(`=== 수집 완료: 총 ${collectedReviews.length}개 리뷰, ${currentPage}페이지 ===`);

    isCollecting = false;
    const result = buildResult();
    log("최종 결과:", JSON.stringify(result).slice(0, 500));
    chrome.runtime.sendMessage({ type: "complete", data: result });
  }

  function parseCurrentPageReviews() {
    const reviews = [];

    // 전략 1: 도움이 돼요 버튼의 부모를 리뷰 아이템으로 사용
    let articles = [];
    let matchedSelector = "";

    const helpItems = document.querySelectorAll(
      ".sdp-review__article__list__help, .js_reviewArticleHelpfulContainer"
    );
    if (helpItems.length > 0) {
      articles = Array.from(helpItems).map((el) => el.parentElement).filter(Boolean);
      matchedSelector = "helpBtn.parentElement";
    }

    // 전략 2: 별점 아이콘 기반 — 별점이 있는 블록의 공통 조상 탐색
    if (articles.length === 0) {
      const stars = document.querySelectorAll(".sdp-review i[class*='twc-bg-full-star']");
      if (stars.length > 0) {
        // 별점 그룹의 조상 중 리뷰 아이템 레벨을 찾기
        const reviewItems = new Set();
        stars.forEach((star) => {
          // 별점 → 3~5단계 위 부모가 리뷰 아이템
          let el = star;
          for (let i = 0; i < 5; i++) {
            el = el.parentElement;
            if (!el) break;
          }
          if (el && el.querySelector("div[class*='twc-break-all']")) {
            reviewItems.add(el);
          }
        });
        if (reviewItems.size > 0) {
          articles = Array.from(reviewItems);
          matchedSelector = "star-ancestor";
        }
      }
    }

    // 전략 3: 일반 셀렉터 폴백
    if (articles.length === 0) {
      const fallbackSelectors = [
        ".sdp-review__article__list__review",
        ".js_reviewArticleReviewList article",
        ".sdp-review__article__list > article",
        "article.sdp-review__article__list__review",
        "article[class*='review']",
        ".sdp-review > div > div",
      ];
      for (const sel of fallbackSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0 && found.length <= 20) {
          articles = Array.from(found);
          matchedSelector = sel;
          break;
        }
      }
    }

    log(`리뷰 아이템: "${matchedSelector}" → ${articles.length}개`);

    if (articles.length === 0) {
      warn("리뷰 아이템 0개 — 현재 보이는 리뷰 영역 HTML 덤프:");
      const reviewArea = document.querySelector(
        ".sdp-review, [class*='review'][class*='list'], [class*='Review']"
      );
      if (reviewArea) {
        log("리뷰 영역 outerHTML (2000자):", reviewArea.outerHTML.slice(0, 2000));
      } else {
        warn("리뷰 영역 자체를 찾을 수 없음");
        // 전체 body에서 review 관련 요소 재탐색
        log("body 내 'review' 텍스트 포함 요소:");
        document.querySelectorAll("*").forEach((el) => {
          if (el.children.length === 0 && /리뷰|상품평|review/i.test(el.textContent)) {
            log(`  <${el.tagName.toLowerCase()} class="${el.className}"> "${el.textContent.trim().slice(0, 80)}"`);
          }
        });
      }
      return reviews;
    }

    // 첫 번째 리뷰 상세 구조 덤프 (셀렉터 디버깅용)
    if (currentPage === 1) {
      logGroup("🔬 첫 번째 리뷰 아이템 상세 구조");
      const first = articles[0];
      log("outerHTML (3000자):", first.outerHTML.slice(0, 3000));

      // 자식 요소 트리 출력
      function dumpTree(el, depth = 0) {
        const indent = "  ".repeat(depth);
        const cls = el.className ? ` class="${el.className}"` : "";
        const text = el.children.length === 0 ? ` → "${el.textContent.trim().slice(0, 60)}"` : "";
        log(`${indent}<${el.tagName.toLowerCase()}${cls}>${text}`);
        if (depth < 4) { // 4단계까지만
          Array.from(el.children).forEach((child) => dumpTree(child, depth + 1));
        }
      }
      dumpTree(first);
      logGroupEnd();
    }

    articles.forEach((article, idx) => {
      try {
        const review = extractReviewData(article, idx === 0);
        if (review && (review.body || review.author || review.rating > 0)) {
          // Dedup by author+date+rating (body can be empty for photo-only reviews)
          const key = `${review.author}|${review.date}|${review.rating}|${review.body?.slice(0, 30) || ''}`;
          const isDuplicate = collectedReviews.some(
            (r) => `${r.author}|${r.date}|${r.rating}|${r.body?.slice(0, 30) || ''}` === key
          );
          if (!isDuplicate) {
            reviews.push(review);
          } else if (idx === 0) {
            log("첫 리뷰가 중복 — 이미 수집된 페이지일 수 있음");
          }
        }
      } catch (e) {
        warn(`리뷰 #${idx} 파싱 실패:`, e.message);
      }
    });

    return reviews;
  }

  function extractReviewData(article, isFirst = false) {
    // === 쿠팡 2026 Tailwind UI 기반 파싱 ===

    // --- 별점: twc-bg-full-star 아이콘 개수 ---
    const fullStars = article.querySelectorAll("i[class*='twc-bg-full-star']");
    const rating = fullStars.length || 0;
    if (isFirst) log(`  별점: twc-bg-full-star × ${rating}`);

    // --- 작성자: 첫 번째 bold span (프로필 영역) ---
    const authorEl = article.querySelector("span[class*='twc-font-bold'][class*='twc-text-bluegray-900']");
    const author = authorEl ? authorEl.textContent.trim().replace(/\u00a0/g, "") : "";
    if (isFirst) log(`  작성자: "${author}"`);

    // --- 날짜: YYYY.MM.DD 패턴을 포함하는 div ---
    let date = "";
    const allDivs = article.querySelectorAll("div");
    for (const d of allDivs) {
      const t = d.textContent.trim();
      if (/^\d{4}\.\d{2}\.\d{2}$/.test(t)) {
        date = t;
        break;
      }
    }
    if (isFirst) log(`  날짜: "${date}"`);

    // --- 제목: twc-mb-[8px] + twc-font-bold 인 div ---
    let title = "";
    for (const d of allDivs) {
      if (d.className.includes("twc-mb-[8px]") && d.className.includes("twc-font-bold")) {
        title = d.textContent.trim();
        break;
      }
    }
    if (isFirst) log(`  제목: "${title.slice(0, 60)}"`);

    // --- 본문: 여러 패턴 시도 ---
    let body = "";
    // 패턴 1: twc-break-all
    const bodyEl1 = article.querySelector("div[class*='twc-break-all']");
    if (bodyEl1) {
      body = bodyEl1.textContent.trim();
    }
    // 패턴 2: 긴 텍스트가 있는 div (프로필/날짜/옵션 제외)
    if (!body) {
      const allDivs2 = article.querySelectorAll("div");
      for (const d of allDivs2) {
        const text = d.textContent.trim();
        // 본문은 보통 20자 이상이고, 날짜/옵션이 아닌 블록
        if (
          text.length > 20 &&
          d.children.length === 0 &&
          !/^\d{4}\.\d{2}\.\d{2}$/.test(text) &&
          !d.className.includes("twc-line-clamp") &&
          !d.className.includes("twc-gap-[12px]") &&
          !d.closest("[class*='twc-rounded-[50%]']") // 프로필 아바타 영역 제외
        ) {
          body = text;
          break;
        }
      }
    }
    if (isFirst) log(`  본문: "${body.slice(0, 80)}${body.length > 80 ? '...' : ''}"`);

    // --- 속성 평가 (편리성: 아주 편리해요 등) ---
    const attributes = {};
    const attrRows = article.querySelectorAll("div[class*='twc-flex'][class*='twc-gap-[12px]']");
    attrRows.forEach((row) => {
      const spans = row.querySelectorAll("span");
      if (spans.length >= 2) {
        const key = spans[0].textContent.trim();
        const val = spans[1].textContent.trim();
        // 속성 라벨은 보통 2~4글자 (편리성, 견고함 등)
        if (key.length >= 2 && key.length <= 6 && val.length > 0) {
          attributes[key] = val;
        }
      }
    });
    if (isFirst && Object.keys(attributes).length) log(`  속성:`, attributes);

    // --- 도움이 돼요 수: "N명에게 도움이 됐어요" 텍스트에서 추출 ---
    let helpfulCount = 0;
    const helpfulArea = article.querySelector(".sdp-review__article__list__help, .js_reviewArticleHelpfulContainer");
    if (helpfulArea) {
      const helpText = helpfulArea.textContent;
      const helpMatch = helpText.match(/(\d+)\s*명/);
      if (helpMatch) helpfulCount = parseInt(helpMatch[1]);
    }
    if (isFirst) log(`  도움: ${helpfulCount}명`);

    // --- 사진/영상: 갤러리 영역의 img ---
    const galleryDiv = article.querySelector("div[class*='twc-overflow-x-auto']");
    const photos = galleryDiv ? galleryDiv.querySelectorAll("img") : [];
    const isPhotoReview = photos.length > 0;
    const photoUrls = Array.from(photos).map((img) => img.src).filter(Boolean);
    if (isFirst) log(`  사진: ${photos.length}개`);

    // --- 구매 옵션 (상품 변형) ---
    let productOption = "";
    const optionEl = article.querySelector("div[class*='twc-line-clamp']");
    if (optionEl) productOption = optionEl.textContent.trim();
    if (isFirst) log(`  옵션: "${productOption.slice(0, 50)}"`);

    return {
      rating,
      date,
      author,
      title,
      body,
      helpful_count: helpfulCount,
      is_photo_review: isPhotoReview,
      photo_urls: photoUrls,
      attributes,
      product_option: productOption,
    };
  }

  async function goToNextPage() {
    const targetPage = currentPage + 1;
    log(`다음 페이지 이동 시도: ${targetPage}`);

    // 다음 번호 버튼 직접 찾기
    const btns = getPageButtons();
    for (const btn of btns) {
      const num = parseInt(btn.textContent.trim());
      if (num === targetPage) {
        log(`페이지 ${num} 버튼 클릭`);
        btn.click();
        await waitForReviewsReload();
        return true;
      }
    }

    // 버튼에 targetPage가 없으면 "다음" 화살표 클릭
    const sdpReview = document.querySelector(".sdp-review");
    if (sdpReview) {
      const allBtns = Array.from(sdpReview.querySelectorAll("button"));
      // 화살표 버튼: SVG 포함 + 숫자 텍스트 없음
      const arrowBtns = allBtns.filter(
        (btn) => btn.querySelector("svg") && !/\d/.test(btn.textContent.trim())
      );
      // 숫자 버튼들의 위치를 기준으로 그 뒤에 있는 화살표 = "다음"
      const pageBtnIndices = allBtns
        .map((btn, i) => /^\d+$/.test(btn.textContent.trim()) ? i : -1)
        .filter(i => i >= 0);
      const lastPageBtnIdx = pageBtnIndices.length > 0 ? pageBtnIndices[pageBtnIndices.length - 1] : -1;

      for (const arrow of arrowBtns) {
        const arrowIdx = allBtns.indexOf(arrow);
        if (arrowIdx > lastPageBtnIdx && !arrow.disabled) {
          log(`"다음" 화살표 클릭 (index ${arrowIdx})`);
          arrow.click();
          await waitForReviewsReload();
          return true;
        }
      }
    }

    log("다음 페이지 버튼 없음 — 마지막 페이지");
    return false;
  }

  async function waitForReviewsReload() {
    // 페이지 클릭 후 리뷰 DOM이 갱신될 때까지 대기
    const before = document.querySelectorAll(
      ".sdp-review__article__list__help, .js_reviewArticleHelpfulContainer"
    );
    const beforeCount = before.length;
    const beforeFirst = before[0]?.parentElement?.textContent?.slice(0, 50) || "";

    await sleep(800);

    // 최대 3초간 DOM 변경 감지 대기
    for (let i = 0; i < 6; i++) {
      const after = document.querySelectorAll(
        ".sdp-review__article__list__help, .js_reviewArticleHelpfulContainer"
      );
      const afterFirst = after[0]?.parentElement?.textContent?.slice(0, 50) || "";
      if (afterFirst !== beforeFirst || after.length !== beforeCount) {
        log(`리뷰 DOM 갱신 감지 (${(i + 1) * 500}ms)`);
        break;
      }
      await sleep(500);
    }

    // 리뷰 영역으로 스크롤 유지
    const sdpReview = document.querySelector(".sdp-review");
    if (sdpReview) sdpReview.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildResult() {
    const urlMatch = window.location.pathname.match(/products\/(\d+)/);
    const productId = urlMatch ? urlMatch[1] : "";

    const productName =
      document.querySelector("h1.prod-buy-header__title")?.textContent?.trim() ||
      document.querySelector("h2.prod-buy-header__title")?.textContent?.trim() ||
      document.title;

    const avgRating = collectedReviews.length
      ? (collectedReviews.reduce((sum, r) => sum + r.rating, 0) / collectedReviews.length).toFixed(1)
      : 0;

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    collectedReviews.forEach((r) => {
      if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++;
    });

    return {
      productId,
      productName,
      productUrl: window.location.href,
      collectedAt: new Date().toISOString(),
      totalReviews: collectedReviews.length,
      totalPages: currentPage,
      avgRating: parseFloat(avgRating),
      ratingDistribution: distribution,
      photoReviewCount: collectedReviews.filter((r) => r.is_photo_review).length,
      reviews: collectedReviews,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendProgress(status, progress, pageCount) {
    chrome.runtime.sendMessage({
      type: "progress",
      status,
      progress: Math.round(progress),
      reviewCount: collectedReviews.length,
      pageCount: pageCount || currentPage,
    });
  }

  function sendError(message) {
    isCollecting = false;
    chrome.runtime.sendMessage({ type: "error", message });
  }
})();
