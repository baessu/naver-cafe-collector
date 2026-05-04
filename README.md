# Naver Cafe Collector

네이버 카페 게시글의 **제목, 본문, 댓글**을 수집하여 JSON 파일로 저장하는 Chrome Extension.

## 기능

- 게시글 제목, 작성자, 날짜 추출
- Smart Editor 3 본문 파싱 (텍스트, 이미지, 링크, 스티커 구분)
- 댓글 수집 (텍스트 / 스티커 / 대댓글 구분)
- JSON 파일 다운로드 (`YYYYMMDD_cafe{카페ID}_{글번호}.json`)
- JSON / 텍스트 클립보드 복사

## 설치

1. 이 레포를 클론하거나 ZIP 다운로드
   ```bash
   git clone https://github.com/baessu/naver-cafe-collector.git
   ```
2. Chrome에서 `chrome://extensions` 접속
3. 우측 상단 **개발자 모드** ON
4. **압축해제된 확장 프로그램을 로드합니다** 클릭
5. 클론한 폴더 선택

## 사용법

1. 네이버 카페 게시글 페이지로 이동
2. 익스텐션 아이콘 클릭
3. **[수집]** 버튼으로 데이터 추출
4. **[JSON 저장]** 으로 파일 다운로드 또는 **[JSON 복사]** 로 클립보드 복사

## 출력 예시

```json
{
  "title": "게시글 제목",
  "author": "작성자",
  "date": "2025.08.05. 09:59",
  "url": "https://cafe.naver.com/...",
  "body": "본문 텍스트...",
  "comments": [
    {
      "author": "닉네임",
      "text": "댓글 내용",
      "date": "2025.08.05. 10:02",
      "type": "text",
      "isReply": false
    }
  ],
  "collectedAt": "2026-05-04T13:37:34.989Z"
}
```

## 기술 구조

네이버 카페는 `#cafe_main` iframe 안에 게시글 콘텐츠가 렌더링됨. `content.js`가 `all_frames: true`로 주입되어 iframe 내부 DOM에 직접 접근.

| 항목 | 셀렉터 |
|------|--------|
| 제목 | `h3.title_text` |
| 본문 | `.article_viewer .se-main-container` |
| 글쓴이 | `.WriterInfo .nickname` |
| 날짜 | `.article_info .date` |
| 댓글 목록 | `ul.comment_list > li.CommentItem` |
| 댓글 닉네임 | `a.comment_nickname` |
| 댓글 텍스트 | `span.text_comment` |
| 댓글 날짜 | `span.comment_info_date` |
| 스티커 | `.CommentItemSticker img` |

## 권한

| 권한 | 용도 |
|------|------|
| `activeTab` | 현재 탭 접근 |
| `scripting` | content script 주입 |
| `webNavigation` | iframe 프레임 목록 조회 |
| `downloads` | JSON 파일 저장 |
