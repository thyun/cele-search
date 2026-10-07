/**
 * YouTube search logic for "celebrity product ad" longform content.
 *
 * Flow:
 * 1. search.list for each keyword (default set + optional user keyword),
 *    restricted to the last 6 months, ordered by view count.
 * 2. videos.list to fetch duration/statistics for the candidate videos.
 * 3. Filter out anything shorter than 4 minutes (longform threshold, i.e.
 *    excludes YouTube Shorts and short clips).
 * 4. Score by view count weighted by recency ("hot" content first) and
 *    return the page's results and continuation state.
 */

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
const LONGFORM_MIN_SECONDS = 4 * 60;

/** Base keyword set covering celebrity product advertisement content. */
export const DEFAULT_KEYWORDS = [
  "연예인 광고",
  "셀럽 PPL",
  "스타 협찬",
  "연예인 신제품 광고",
  "아이돌 광고 촬영",
];

export interface YoutubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  hotScore: number;
  url: string;
  keyword: string;
}

interface SearchListItem {
  id: { videoId?: string };
  snippet?: {
    title: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: { medium?: { url: string }; default?: { url: string } };
  };
}

interface VideosListItem {
  id: string;
  snippet?: {
    title: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: { medium?: { url: string }; default?: { url: string } };
  };
  contentDetails?: { duration: string };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
}

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || key === "your_youtube_data_api_v3_key_here") {
    throw new Error(
      "YOUTUBE_API_KEY is not set. Add it to your .env file before searching.",
    );
  }
  return key;
}

/** Parses an ISO 8601 duration (e.g. "PT1H2M3S") into total seconds. */
export function parseIsoDuration(duration: string): number {
  const match = duration.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/,
  );
  if (!match) return 0;
  const [, hours, minutes, seconds] = match;
  return (
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0)
  );
}

/**
 * Computes a "hotness" score combining raw view count with a recency
 * boost, so recently uploaded videos with strong views rank higher than
 * older videos with similar view counts.
 */
export function computeHotScore(viewCount: number, publishedAt: string): number {
  const daysAgo =
    (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24);
  const clampedDaysAgo = Math.max(0, Math.min(180, daysAgo));
  const recencyWeight = 1 + (180 - clampedDaysAgo) / 180; // 1.0 (old) ~ 2.0 (new)
  return viewCount * recencyWeight;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `YouTube API request failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  return res.json() as Promise<T>;
}

async function searchVideoIdsForKeyword(
  keyword: string,
  publishedAfter: string,
  apiKey: string,
  pageToken?: string,
) {
  const params = new URLSearchParams({
    key: apiKey,
    q: keyword,
    part: "snippet",
    type: "video",
    order: "viewCount",
    publishedAfter,
    maxResults: "50",
    relevanceLanguage: "ko",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const data = await fetchJson<{ items: SearchListItem[]; nextPageToken?: string }>(
    `${YOUTUBE_API_BASE}/search?${params.toString()}`,
  );
  const map = new Map<string, string>();
  for (const item of data.items ?? []) {
    const id = item.id?.videoId;
    if (id) map.set(id, keyword);
  }
  return { videoIds: map, nextPageToken: data.nextPageToken ?? null };
}

async function fetchVideoDetails(
  videoIds: string[],
  apiKey: string,
): Promise<VideosListItem[]> {
  if (videoIds.length === 0) return [];
  const results: VideosListItem[] = [];
  // videos.list allows up to 50 ids per request.
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      key: apiKey,
      id: batch.join(","),
      part: "snippet,contentDetails,statistics",
    });
    const data = await fetchJson<{ items: VideosListItem[] }>(
      `${YOUTUBE_API_BASE}/videos?${params.toString()}`,
    );
    results.push(...(data.items ?? []));
  }
  return results;
}

export interface SearchContinuation {
  publishedAfter: string;
  keywords: { keyword: string; pageToken: string | null }[];
  seenVideoIds: string[];
}

export interface SearchOptions {
  userKeyword?: string;
  continuation?: SearchContinuation;
}

export async function searchCelebrityAdLongformVideos(
  options: SearchOptions = {},
) {
  const apiKey = getApiKey();
  const keywords = [...DEFAULT_KEYWORDS];
  const userKeyword = options.userKeyword?.trim();
  if (userKeyword) {
    // Combine the user's keyword with an ad-related term so results stay on-topic.
    keywords.unshift(`${userKeyword} 광고`);
  }

  const state: SearchContinuation = options.continuation ?? {
    publishedAfter: new Date(Date.now() - SIX_MONTHS_MS).toISOString(),
    keywords: keywords.map((keyword) => ({ keyword, pageToken: "" })),
    seenVideoIds: [],
  };
  const seen = new Set(state.seenVideoIds);

  const keywordByVideoId = new Map<string, string>();
  const searchResults = await Promise.all(
    state.keywords.map(async ({ keyword, pageToken }) =>
      pageToken === null
        ? { videoIds: new Map<string, string>(), nextPageToken: null }
        : searchVideoIdsForKeyword(
            keyword, state.publishedAfter, apiKey, pageToken || undefined,
          ),
    ),
  );
  for (const page of searchResults) {
    for (const [videoId, keyword] of page.videoIds) {
      if (!seen.has(videoId) && !keywordByVideoId.has(videoId)) {
        keywordByVideoId.set(videoId, keyword);
      }
    }
  }

  const videoIds = [...keywordByVideoId.keys()];
  const details = await fetchVideoDetails(videoIds, apiKey);

  const results: YoutubeSearchResult[] = [];
  for (const video of details) {
    if (!video.snippet || !video.contentDetails || !video.statistics) continue;
    const durationSeconds = parseIsoDuration(video.contentDetails.duration);
    // Longform filter: exclude Shorts / short clips under 4 minutes.
    if (durationSeconds < LONGFORM_MIN_SECONDS) continue;

    const viewCount = Number(video.statistics.viewCount ?? 0);
    const publishedAt = video.snippet.publishedAt;

    results.push({
      videoId: video.id,
      title: video.snippet.title,
      channelTitle: video.snippet.channelTitle,
      publishedAt,
      thumbnailUrl:
        video.snippet.thumbnails?.medium?.url ??
        video.snippet.thumbnails?.default?.url ??
        "",
      durationSeconds,
      viewCount,
      likeCount: Number(video.statistics.likeCount ?? 0),
      commentCount: Number(video.statistics.commentCount ?? 0),
      hotScore: computeHotScore(viewCount, publishedAt),
      url: `https://www.youtube.com/watch?v=${video.id}`,
      keyword: keywordByVideoId.get(video.id) ?? "",
    });
  }

  results.sort((a, b) => b.hotScore - a.hotScore);
  return {
    results,
    continuation: {
      publishedAfter: state.publishedAfter,
      keywords: state.keywords.map((entry, index) => ({
        keyword: entry.keyword,
        pageToken: searchResults[index].nextPageToken,
      })),
      seenVideoIds: [...seen, ...videoIds],
    } satisfies SearchContinuation,
  };
}
