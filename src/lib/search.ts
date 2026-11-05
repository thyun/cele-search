import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "cele-search.db");
const PAGE_SIZE = 20;

export interface VideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  subscriberCount: number | null;
  publishedAt: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  efficiencyScore: number;
  url: string;
}

export class InvalidSearchCursorError extends Error {
  constructor() {
    super("잘못된 더보기 요청입니다. 다시 검색해주세요.");
  }
}

export class SearchDatabaseMissingError extends Error {
  constructor() {
    super("수집된 데이터가 없습니다. 먼저 `npm run batch`를 실행해주세요.");
  }
}

interface VideoRow {
  video_id: string;
  title: string;
  channel_title: string;
  subscriber_count: number | null;
  published_at: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  efficiency_score: number;
}

/**
 * Reads batch-collected videos from SQLite, ranked by views relative to
 * subscribers. The cursor is the number of results already shown, so each
 * call returns every result up to the next page.
 */
export function searchVideos(userQuery?: string, cursor?: string) {
  let offset = 0;
  if (cursor !== undefined) {
    if (!/^\d{1,6}$/.test(cursor)) throw new InvalidSearchCursorError();
    offset = Number(cursor);
  }

  const query = userQuery?.trim() || null;
  const limit = offset + PAGE_SIZE;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    throw new SearchDatabaseMissingError();
  }
  try {
    const like = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = db
      .prepare(
        `SELECT v.video_id, v.title, c.title AS channel_title, c.subscriber_count,
                v.published_at, v.thumbnail_url, v.duration_seconds, v.view_count,
                v.like_count, v.comment_count, v.efficiency_score
         FROM videos v JOIN channels c ON c.channel_id = v.channel_id
         WHERE (?1 IS NULL OR v.title LIKE ?1 ESCAPE '\\' OR c.title LIKE ?1 ESCAPE '\\')
         ORDER BY v.efficiency_score DESC, v.view_count DESC
         LIMIT ?2`,
      )
      .all(like, limit + 1) as unknown as VideoRow[];

    const results: VideoResult[] = rows.slice(0, limit).map((row) => ({
      videoId: row.video_id,
      title: row.title,
      channelTitle: row.channel_title,
      subscriberCount: row.subscriber_count,
      publishedAt: row.published_at,
      thumbnailUrl: row.thumbnail_url ?? "",
      durationSeconds: row.duration_seconds,
      viewCount: row.view_count,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      efficiencyScore: row.efficiency_score,
      url: `https://www.youtube.com/watch?v=${row.video_id}`,
    }));
    return {
      query,
      results,
      nextCursor: rows.length > limit ? String(limit) : null,
    };
  } finally {
    db.close();
  }
}
