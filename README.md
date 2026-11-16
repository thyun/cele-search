# cele-search

연예인이 광고하는 상품을 다루는 **롱폼·쇼츠** YouTube 컨텐츠를, **최근 6개월** 범위에서
검색하고 구독자 대비 조회수가 높은 순으로 보여주는 Next.js 웹앱입니다.

## 주요 기능

- 채널 배치(`npm run batch:channels`)가 YouTube API로 채널을 발굴하고 정보를 MySQL(`MYSQL_DATABASE`)에 저장
- 영상 배치(`npm run batch:videos`)는 기존 채널 정보를 갱신한 뒤 영상을 수집 (새 채널 검색 없음)
- 채널별 최근 영상 최대 30개 중 6개월 이내 영상을 쇼츠 후보까지 함께 수집
- DB의 `videos.is_short`는 1초~3분 영상을 `1`, 나머지는 `0`으로 저장 (길이 기반 추정이며 실제 쇼츠 여부를 보장하지 않음)
- 웹 검색은 영상 길이와 쇼츠 여부를 구분하지 않고 수집된 영상을 함께 표시
- 배치에서 지상파·종편·보도·케이블 방송사 브랜드(KBS·MBC·SBS·EBS·JTBC·채널A·TV조선·MBN·YTN·연합뉴스·tvN·Mnet 등)가 포함된 채널명을 제외
- 기존 방송사 채널과 영상도 배치 시작 시 삭제하며, 제외된 채널 ID는 `excluded_channels`에 기록해 재수집 방지
- **구독자 수 대비 조회수**(`조회수 / max(구독자수, 1000)`)가 높은 영상을 우선 표시, 20개씩 **더보기**
- 웹 검색은 DB만 조회하므로 YouTube API 쿼터를 쓰지 않음 (검색어는 영상/채널 제목에서 검색)

## 사전 준비: YouTube Data API 키 발급

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. **YouTube Data API v3** 활성화
3. API 키(사용자 인증 정보) 발급

## 설치 및 실행

```bash
npm install
```

프로젝트 루트의 `.env` 파일을 열어 발급받은 키를 입력하세요.

```bash
# .env
YOUTUBE_API_KEY=발급받은_API_키
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=cele_search
```

`.env.example` 파일을 참고해 새 환경에서도 동일하게 설정할 수 있습니다.
`.env`는 `.gitignore`에 포함되어 있어 저장소에 커밋되지 않습니다.

데이터 수집 (수동 배치, Node 22.5+ 필요):

```bash
npm run batch:channels                            # 기본 키워드 5개 × 2페이지로 채널 발굴 + 구독자 수·uploads ID 갱신
npm run batch:channels -- --pages=3 --keyword=손흥민 # 페이지 수 / 추가 키워드
npm run batch:channels -- --skip-discover           # 새 채널 발굴 없이 기존 채널 정보만 갱신
npm run batch:videos                              # 기존 채널 정보 갱신 후 롱폼·쇼츠 영상 수집 및 점수 갱신
npm run batch                                     # 기존 호환: 채널 배치와 영상 배치를 순서대로 실행
```

처음에는 채널 배치 실행 후 영상 배치를 실행합니다. 이후 영상만 갱신하려면 `batch:videos`만 실행하면 됩니다.
영상 배치도 기존 채널의 구독자 수·uploads ID를 먼저 갱신하므로 최신 구독자 수로 영상 점수를 계산합니다.
채널 배치 쿼터: `search.list` 100 units/회(기본 약 1,000 units) + `channels.list` 50개당 1 unit.
영상 배치 쿼터: `channels.list` 50개당 1 unit + 채널당 `playlistItems.list` 1 unit + `videos.list` 50개당 1 unit (`search.list` 호출 없음).
로컬 MySQL은 `MYSQL_*` 환경변수로 연결하고, 기본 DB는 `cele_search`를 사용합니다. `DB_PATH`는 SQLite 폴백용으로만 사용됩니다.
기존 DB는 배치 실행 시 `is_short` 필드를 자동으로 추가하고 기존 영상의 길이를 기준으로 값을 채웁니다.
이전에 제외됐던 짧은 영상은 다음 배치에서 채널별 최근 영상 조회 범위에 포함되면 저장됩니다.
방송사 제외는 채널명 규칙과 제외 ID에 기반합니다. 방송사 이름이 없는 별도 브랜드 채널은 누락될 수 있으며,
이 필터는 개별 영상의 저작권이나 이용 허락 여부를 판단하지 않습니다.

개발 서버 실행:

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후 검색어(선택)를 입력하거나 비워둔 채 검색합니다.
먼저 배치를 실행해 DB를 채워야 결과가 나옵니다. JavaScript 없이도 일반 폼 제출로 동작합니다.

## 디렉터리 구조

- `scripts/batch.mjs` — 채널 발굴/영상 수집/점수 계산 배치 (YouTube API 사용)
- `src/lib/search.ts` — SQLite 조회 및 페이지네이션 (커서 = 이미 표시한 결과 수)
- `src/app/api/search/route.ts` — 검색 API 라우트
- `src/app/page.tsx` — 일반 폼 제출의 서버 검색 및 결과 렌더링
- `src/app/search-form.tsx` — 검색 UI 및 결과 화면
- MySQL `cele_search` — 기본 실행 DB; 로컬 루트 계정으로 생성

## YouTube API 할당량

기본 한도는 하루 10,000 units입니다. 웹 검색은 API를 호출하지 않으며, 배치만 쿼터를 사용합니다.
저장된 YouTube 데이터는 정책상 주기적으로(약 30일 이내) 갱신해야 하므로 배치를 정기적으로 실행하세요.
