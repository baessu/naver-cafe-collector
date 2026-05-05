// content_iherb.js — 아이허브 리뷰 수집 (v2 — 실제 DOM 구조 기반)
// 콘솔(F12)에서 [IHR] 태그로 추적

(() => {
  const DEBUG = true;
  const TAG = "[IHR]";

  function log(...args) { if (DEBUG) console.log(TAG, ...args); }
  function warn(...args) { if (DEBUG) console.warn(TAG, ...args); }
  function logGroup(label) { if (DEBUG) console.group(`${TAG} ${label}`); }
  function logGroupEnd() { if (DEBUG) console.groupEnd(); }

  let collectedReviews = [];
  let currentPage = 0;
  let totalPages = 0;
  let isCollecting = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "startCollect" && !isCollecting) {
      log("=== 수집 시작 명령 수신 ===");
      isCollecting = true;
      collectedReviews = [];
      currentPage = 0;
      startCollection();
    }
  });

  log("content_iherb.js 로드됨");
  log("URL:", window.location.href);

  // 로드 시 기본 정보
  const reviewItems = getReviewItems();
  log(`페이지 로드 시 리뷰 아이템: ${reviewItems.length}개`);
  if (reviewItems.length > 0) {
    log("첫 아이템 class:", reviewItems[0].className.slice(0, 80));
  }

  function getReviewItems() {
    // 핵심: #reviews > div.MuiBox-root.css-1v71s4n
    // .review-card (요약 카드)는 제외
    const allDivs = document.querySelectorAll("#reviews > div.MuiBox-root");
    return Array.from(allDivs).filter((div) => {
      // review-card (요약 위젯)는 제외
      if (div.classList.contains("review-card")) return false;
      // 리뷰 아이템은 data-testid="review-posted-date"를 포함
      if (div.querySelector("[data-testid='review-posted-date']")) return true;
      // 또는 작성자 링크 + 날짜 텍스트가 있는 경우
      if (div.querySelector("a[href*='/me/']") && div.textContent.includes("게시됨")) return true;
      return false;
    });
  }

  async function startCollection() {
    try {
      sendProgress("리뷰 섹션 탐색 중...", 0);

      // 리뷰 섹션으로 스크롤
      const reviewsEl = document.querySelector("#reviews");
      if (reviewsEl) {
        reviewsEl.scrollIntoView({ behavior: "smooth", block: "start" });
        await sleep(1500);
      }

      // 총 페이지 수
      totalPages = detectTotalPages();
      log(`총 페이지 수: ${totalPages}`);
      sendProgress(`총 ${totalPages}페이지. 수집 시작...`, 5);

      // 수집
      await collectAllPages();

    } catch (err) {
      warn("수집 에러:", err);
      sendError(`수집 중 오류: ${err.message}`);
    }
  }

  function detectTotalPages() {
    // MUI Pagination 버튼에서 최대 번호
    const paginationBtns = document.querySelectorAll(".MuiPaginationItem-root");
    let maxPage = 1;
    paginationBtns.forEach((btn) => {
      const num = parseInt(btn.textContent.trim());
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });
    if (maxPage > 1) {
      log(`MUI Pagination → 최대 ${maxPage}`);
      return maxPage;
    }

    // fallback
    const pagination = document.querySelector("[class*='Pagination']");
    if (pagination) {
      const allBtns = pagination.querySelectorAll("button");
      allBtns.forEach((btn) => {
        const num = parseInt(btn.textContent.trim());
        if (!isNaN(num) && num > maxPage) maxPage = num;
      });
    }

    return maxPage || 1;
  }

  async function collectAllPages() {
    let consecutiveEmpty = 0;

    while (true) {
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
          logGroupEnd();
          break;
        }
      } else {
        consecutiveEmpty = 0;
        collectedReviews.push(...reviews);
        log(`누적: ${collectedReviews.length}개`);
      }

      logGroupEnd();

      sendProgress(`${currentPage}페이지 완료 (총 ${collectedReviews.length}개)`, progress, currentPage);

      const hasNext = await goToNextPage();
      if (!hasNext) {
        log("다음 페이지 없음 → 종료");
        break;
      }

      await sleep(1500 + Math.random() * 1000);
    }

    log(`=== 수집 완료: ${collectedReviews.length}개, ${currentPage}페이지 ===`);

    isCollecting = false;
    const result = buildResult();
    log("최종 결과:", JSON.stringify(result).slice(0, 500));
    chrome.runtime.sendMessage({ type: "complete", data: result });
  }

  function parseCurrentPageReviews() {
    const reviews = [];
    const items = getReviewItems();

    log(`리뷰 아이템: ${items.length}개`);

    if (items.length === 0) {
      warn("아이템 0개 — #reviews 내부 덤프:");
      const el = document.querySelector("#reviews");
      if (el) {
        // 자식 div 목록
        const kids = el.querySelectorAll(":scope > div");
        kids.forEach((k, i) => {
          log(`  [${i}] class="${k.className.slice(0, 60)}" text="${k.textContent.trim().slice(0, 80)}"`);
        });
      }
      return reviews;
    }

    // 첫 아이템 상세 덤프
    if (currentPage === 1 && items.length > 0) {
      logGroup("🔬 첫 번째 리뷰 상세");
      log("outerHTML (3000자):", items[0].outerHTML.slice(0, 3000));
      logGroupEnd();
    }

    items.forEach((item, idx) => {
      try {
        const review = extractReview(item, idx === 0);
        if (review && (review.body || review.title)) {
          const isDuplicate = collectedReviews.some(
            (r) => r.body === review.body && r.author === review.author
          );
          if (!isDuplicate) reviews.push(review);
        }
      } catch (e) {
        warn(`리뷰 #${idx} 실패:`, e.message);
      }
    });

    return reviews;
  }

  function extractReview(item, isFirst = false) {
    const fullText = item.textContent;

    // --- 작성자 ---
    let author = "";
    // 1) 프로필 링크
    const authorLink = item.querySelector("a[href*='/me/']");
    if (authorLink) {
      author = authorLink.textContent.trim();
    }
    // 2) "아이허브 고객" + 등급(골드/실버 등) 조합
    if (!author) {
      const typos = item.querySelectorAll(".MuiTypography-root");
      for (const t of typos) {
        const txt = t.textContent.trim();
        if (txt.includes("고객") || txt.includes("Customer")) {
          // 다음 형제에 등급이 있을 수 있음
          const next = t.nextElementSibling;
          const grade = next ? next.textContent.trim() : "";
          author = grade ? `${txt}${grade}` : txt;
          break;
        }
      }
    }
    if (isFirst) log(`  작성자: "${author}"`);

    // --- 날짜 ---
    let date = "";
    const dateEl = item.querySelector("[data-testid='review-posted-date']");
    if (dateEl) {
      date = dateEl.textContent.trim();
    }
    if (isFirst) log(`  날짜: "${date}"`);

    // --- 국가 ---
    let country = "";
    const allSpans = item.querySelectorAll("span.MuiTypography-body2");
    for (const s of allSpans) {
      const t = s.textContent.trim();
      if (t !== date && !t.includes("게시") && !t.includes("검증") && !t.includes("리워드")
          && t.length > 1 && t.length < 20 && !t.match(/^\d/)) {
        country = t;
        break;
      }
    }
    if (isFirst) log(`  국가: "${country}"`);

    // --- 별점 ---
    // svg[width="24"][stroke-width="1.6"] = 별 아이콘 (5개)
    // 채워진 별: path fill="#FAC627" (노란색)
    // 빈 별: path fill 없음 또는 다른 색
    let rating = 0;
    const starSvgs = item.querySelectorAll('svg[width="24"][stroke-width="1.6"]');
    if (starSvgs.length > 0) {
      starSvgs.forEach((svg) => {
        const path = svg.querySelector("path");
        if (path) {
          const fill = path.getAttribute("fill");
          if (fill && fill !== "none" && fill !== "transparent") {
            rating++;
          }
        }
      });
    }

    // fallback: 별 아이콘이 없으면 다른 패턴 시도
    if (!rating && starSvgs.length === 0) {
      // viewBox="0 0 24 24" + stroke-width 없는 별 SVG
      const altStars = item.querySelectorAll('svg[width="24"][viewBox="0 0 24 24"]');
      altStars.forEach((svg) => {
        const path = svg.querySelector("path");
        if (path) {
          const fill = path.getAttribute("fill");
          const d = path.getAttribute("d") || "";
          // 별 path는 "18.559" 패턴 포함
          if (d.includes("18.559") || d.includes("18.437")) {
            if (fill && fill !== "none" && fill !== "transparent") {
              rating++;
            }
          }
        }
      });
    }

    if (isFirst) log(`  별점: ${rating} (SVG ${starSvgs.length}개 중 filled)`);

    // --- 제목 ---
    let title = "";
    // 리뷰 제목은 보통 bold 텍스트 또는 별도 요소
    // 텍스트에서 "검증된 구매" 전에 나오는 짧은 텍스트가 제목
    // 패턴: 국가 다음, "검증된 구매" 전
    const allTexts = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t.length > 0) allTexts.push({ text: t, parent: node.parentElement });
    }

    // "검증된 구매" 또는 "리워드" 이전의 마지막 짧은 텍스트가 제목
    let foundDate = false;
    let foundCountry = false;
    let afterSummaryNumbers = false;
    for (const { text, parent } of allTexts) {
      if (text === date) { foundDate = true; continue; }
      if (text === country) { foundCountry = true; continue; }
      if (/^\d+$/.test(text)) { afterSummaryNumbers = true; continue; }
      if (text.includes("검증된 구매") || text.includes("Verified")) continue;
      if (text.includes("리워드") || text.includes("Reward")) continue;
      if (text.includes("게시됨") || text.includes("Posted")) continue;

      if (foundCountry && afterSummaryNumbers && text.length >= 2 && text.length <= 50
          && !title && parent.tagName !== "BUTTON") {
        title = text;
        continue;
      }
    }
    if (isFirst) log(`  제목: "${title}"`);

    // --- 본문 ---
    let body = "";
    // 본문은 가장 긴 텍스트 블록
    // "검증된 구매" / "리워드" / 버튼 텍스트 제외한 가장 긴 것
    const excludeTexts = new Set([date, country, author, title, "검증된 구매",
      "리워드 크레딧이 지급된 구매후기", "도움이 됨", "도움이 되지 않음",
      "신고", "번역"]);
    let longestText = "";
    for (const { text, parent } of allTexts) {
      if (excludeTexts.has(text)) continue;
      if (parent.tagName === "BUTTON" || parent.tagName === "SVG") continue;
      if (/^\d+$/.test(text)) continue;
      if (text.includes("게시됨")) continue;
      if (text.includes("리워드")) continue;
      if (text.includes("검증된")) continue;
      if (text.length > longestText.length && text.length > 10) {
        longestText = text;
      }
    }
    body = longestText;
    if (isFirst) log(`  본문: "${body.slice(0, 80)}..."`);

    // --- 도움이 돼요 ---
    // "도움이 됨" 버튼 옆 숫자 또는 thumbs-up 카운트
    let helpfulCount = 0;
    const buttons = item.querySelectorAll("button");
    for (const btn of buttons) {
      const btnText = btn.textContent.trim();
      if (btnText.includes("도움이 됨") || btnText.includes("Helpful") || btnText.includes("👍")) {
        const m = btnText.match(/(\d+)/);
        if (m) helpfulCount = parseInt(m[1]);
        break;
      }
    }
    if (isFirst) log(`  도움: ${helpfulCount}`);

    // --- 인증 구매 ---
    const isVerified = fullText.includes("검증된 구매") || fullText.includes("Verified");
    if (isFirst) log(`  인증구매: ${isVerified}`);

    // --- 사진 ---
    // 리뷰 내 이미지 (아바타 제외)
    const imgs = item.querySelectorAll("img");
    const photoUrls = Array.from(imgs)
      .map((img) => img.src || img.getAttribute("data-src"))
      .filter((src) => src && !src.includes("avatar") && !src.includes("iHerb.svg")
        && !src.includes("star") && !src.includes("icon"))
      .filter(Boolean);
    if (isFirst) log(`  사진: ${photoUrls.length}개`);

    // --- 리워드 포인트 ---
    let rewardPoints = 0;
    const ugcSummary = item.querySelector("[data-testid='ugc-summary']");
    if (ugcSummary) {
      const spans = ugcSummary.querySelectorAll("span.MuiTypography-body2");
      if (spans.length > 0) {
        const n = parseInt(spans[0].textContent.trim());
        if (!isNaN(n)) rewardPoints = n;
      }
    }
    if (isFirst) log(`  리워드: ${rewardPoints}`);

    return {
      rating,
      date,
      author,
      country,
      title,
      body,
      helpful_count: helpfulCount,
      is_photo_review: photoUrls.length > 0,
      photo_urls: photoUrls,
      is_verified: isVerified,
      reward_points: rewardPoints,
    };
  }

  async function goToNextPage() {
    // MUI Pagination — 현재 활성 페이지 다음 클릭
    const pagination = document.querySelector("[class*='Pagination']");
    if (!pagination) {
      log("페이지네이션 없음");
      return false;
    }

    // 현재 활성 버튼
    const activeBtn = pagination.querySelector(
      "button[aria-current='true'], button.Mui-selected"
    );
    const activeNum = activeBtn ? parseInt(activeBtn.textContent.trim()) : currentPage;
    log(`현재 활성 페이지: ${activeNum}`);

    // 다음 번호 버튼
    const allBtns = pagination.querySelectorAll("button.MuiPaginationItem-root");
    for (const btn of allBtns) {
      const num = parseInt(btn.textContent.trim());
      if (num === activeNum + 1 && !btn.disabled) {
        log(`다음 페이지 클릭: ${num}`);
        btn.click();
        await sleep(2000);
        // 리뷰 영역으로 스크롤
        const reviewsEl = document.querySelector("#reviews");
        if (reviewsEl) reviewsEl.scrollIntoView({ behavior: "smooth", block: "start" });
        return true;
      }
    }

    // "Next" 화살표 버튼
    const nextBtn = pagination.querySelector(
      "button[aria-label='Go to next page']:not([disabled])"
    );
    if (nextBtn) {
      log(`"Next" 화살표 클릭`);
      nextBtn.click();
      await sleep(2000);
      return true;
    }

    return false;
  }

  function buildResult() {
    const urlMatch = window.location.pathname.match(/\/(\d+)/);
    const productId = urlMatch ? urlMatch[1] : "";

    const productName =
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector("[itemprop='name']")?.textContent?.trim() ||
      document.title;

    const avgRating = collectedReviews.length
      ? (collectedReviews.reduce((sum, r) => sum + r.rating, 0) / collectedReviews.length).toFixed(1)
      : 0;

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    collectedReviews.forEach((r) => {
      if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++;
    });

    return {
      site: "iherb",
      productId,
      productName,
      productUrl: window.location.href,
      collectedAt: new Date().toISOString(),
      totalReviews: collectedReviews.length,
      totalPages: currentPage,
      avgRating: parseFloat(avgRating),
      ratingDistribution: distribution,
      photoReviewCount: collectedReviews.filter((r) => r.is_photo_review).length,
      verifiedCount: collectedReviews.filter((r) => r.is_verified).length,
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
