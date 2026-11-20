import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "cele-search.db");

export function isMysqlEnabled() {
  return process.env.DB_DRIVER === "mysql" || Boolean(process.env.MYSQL_HOST || process.env.MYSQL_DATABASE);
}

function getMysqlConfig() {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "cele_search",
    charset: "utf8mb4",
    timezone: "Z",
  };
}

async function openDatabase(options: { readOnly?: boolean } = {}) {
  if (isMysqlEnabled()) {
    const mysql = await import("mysql2/promise");
    const connection = await mysql.default.createConnection(getMysqlConfig());
    if (options.readOnly) {
      await connection.execute("SET SESSION TRANSACTION READ ONLY");
    }
    return {
      async close() {
        await connection.end();
      },
      prepare(sql: string) {
        return {
          async all(...args: unknown[]) {
            const values = args.flat() as never;
            const [rows] = (await connection.execute(sql, values)) as [unknown[], unknown];
            return rows;
          },
          async get(...args: unknown[]) {
            const values = args.flat() as never;
            const [rows] = (await connection.execute(sql, values)) as [unknown[], unknown];
            return (rows as Record<string, unknown>[])[0] ?? undefined;
          },
          async run(...args: unknown[]) {
            const values = args.flat() as never;
            const [result] = (await connection.execute(sql, values)) as [unknown, unknown];
            const header = result as { affectedRows?: number; insertId?: number };
            return {
              changes: Number(header?.affectedRows ?? 0),
              lastInsertRowid: Number(header?.insertId ?? 0),
            };
          },
        };
      },
    };
  }
  return new DatabaseSync(DB_PATH, options);
}
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
 * Reads batch-collected videos, ranked by views relative to subscribers.
 * The cursor is the number of results already shown, so each call returns
 * every result up to the next page.
 */
export interface SearchFilters {
  viewCountMin?: number;
  viewCountMax?: number;
  dateFrom?: string;
  dateTo?: string;
}

export class InvalidSearchFiltersError extends Error {
  constructor(message = "검색 조건이 올바르지 않습니다.") {
    super(message);
  }
}

export function searchVideos(userQuery?: string, cursor?: string, filters: SearchFilters = {}) {
  let offset = 0;
  if (cursor !== undefined) {
    if (!/^\d{1,6}$/.test(cursor)) throw new InvalidSearchCursorError();
    offset = Number(cursor);
  }

  const query = userQuery?.trim() || null;
  const limit = offset + PAGE_SIZE;

  const viewCountMin = filters.viewCountMin ?? 300_000;
  const viewCountMax = filters.viewCountMax ?? 1_000_000;
  const dateFrom = filters.dateFrom ?? null;
  const dateTo = filters.dateTo ?? null;

  if (!Number.isInteger(viewCountMin) || !Number.isInteger(viewCountMax) || viewCountMin < 0 || viewCountMax < viewCountMin) {
    throw new InvalidSearchFiltersError("조회수 시작값은 종료값보다 작거나 같아야 합니다.");
  }
  if ((dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) || (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo))) {
    throw new InvalidSearchFiltersError("시작일과 종료일을 올바르게 입력해주세요.");
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new InvalidSearchFiltersError("시작일은 종료일보다 이전이어야 합니다.");
  }

  const likeEscape = isMysqlEnabled() ? "ESCAPE '\\\\'" : "ESCAPE '\\'";

  if (isMysqlEnabled()) {
    return (async () => {
      let db;
      try {
        db = await openDatabase({ readOnly: true });
      } catch {
        throw new SearchDatabaseMissingError();
      }
      try {
        const like = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
        const rows = (await db
          .prepare(
            `SELECT v.video_id, v.title, c.title AS channel_title, c.subscriber_count,
                   v.published_at, v.thumbnail_url, v.duration_seconds, v.view_count,
                   v.like_count, v.comment_count, v.efficiency_score
             FROM videos v JOIN channels c ON c.channel_id = v.channel_id
             WHERE (? IS NULL OR v.title LIKE ? ${likeEscape} OR c.title LIKE ? ${likeEscape})
               AND v.view_count >= ? AND v.view_count <= ?
               AND (? IS NULL OR v.published_at >= ?)
               AND (? IS NULL OR v.published_at < DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d'), INTERVAL 1 DAY))
             ORDER BY v.efficiency_score DESC, v.view_count DESC
             LIMIT ?`,
          )
          .all(like, like, like, viewCountMin, viewCountMax, dateFrom, dateFrom, dateTo, dateTo, limit + 1)) as VideoRow[];

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
        await db.close();
      }
    })();
  }

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
         WHERE (? IS NULL OR v.title LIKE ? ${likeEscape} OR c.title LIKE ? ${likeEscape})
           AND v.view_count >= ? AND v.view_count <= ?
           AND (? IS NULL OR v.published_at >= ?)
           AND (? IS NULL OR v.published_at < date(?, '+1 day'))
         ORDER BY v.efficiency_score DESC, v.view_count DESC
         LIMIT ?`,
      )
      .all(like, like, like, viewCountMin, viewCountMax, dateFrom, dateFrom, dateTo, dateTo, limit + 1) as unknown as VideoRow[];

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
