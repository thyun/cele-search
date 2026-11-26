import { openDatabase } from "../../scripts/database.mjs";
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

export interface ChannelListItem {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  discoveredKeyword: string | null;
  discoveredAt: string;
  updatedAt: string;
  isApproved: boolean;
}

export interface ChannelListResult {
  channels: ChannelListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

export async function listChannels(page = 1, pageSize = 20, status: "all" | "pending" | "approved" = "all", query = "") {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : 20;
  const search = query.trim();
  let db;
  try {
    db = await openDatabase({ readOnly: false });
  } catch {
    throw new SearchDatabaseMissingError();
  }

  try {
    const where = `WHERE (? = 'all' OR (? = 'pending' AND is_approved = 0) OR (? = 'approved' AND is_approved = 1))
         AND (? = '' OR title LIKE ? ESCAPE '\\')`;
    const like = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : "";
    const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM channels ${where}`).get(status, status, status, search, like);
    const total = Number(countRow?.total ?? 0);
    const totalPages = Math.ceil(total / safePageSize);
    const currentPage = totalPages > 0 ? Math.min(safePage, totalPages) : 1;
    const offset = (currentPage - 1) * safePageSize;
    const rows = await db.prepare(`
      SELECT channel_id, title, subscriber_count, discovered_keyword, discovered_at, updated_at, is_approved
      FROM channels
      ${where}
      ORDER BY is_approved ASC, updated_at DESC, title ASC
      LIMIT ? OFFSET ?
    `).all(status, status, status, search, like, safePageSize, offset) as Array<{
      channel_id: string;
      title: string;
      subscriber_count: number | null;
      discovered_keyword: string | null;
      discovered_at: string;
      updated_at: string;
      is_approved: number;
    }>;

    return {
      channels: rows.map((row) => ({
        channelId: row.channel_id,
        title: row.title,
        subscriberCount: row.subscriber_count,
        discoveredKeyword: row.discovered_keyword,
        discoveredAt: row.discovered_at,
        updatedAt: row.updated_at,
        isApproved: Number(row.is_approved) === 1,
      })),
      page: currentPage,
      pageSize: safePageSize,
      total,
      totalPages,
    } satisfies ChannelListResult;
  } finally {
    await db.close();
  }
}

export async function setChannelApproved(channelId: string, isApproved: boolean) {
  if (!channelId.trim()) throw new Error("채널 ID가 필요합니다.");
  let db;
  try {
    db = await openDatabase();
  } catch {
    throw new SearchDatabaseMissingError();
  }
  try {
    const result = await db.prepare("UPDATE channels SET is_approved = ?, updated_at = ? WHERE channel_id = ?")
      .run(isApproved ? 1 : 0, new Date().toISOString().slice(0, 19).replace("T", " "), channelId);
    if (result.changes === 0) throw new Error("채널을 찾을 수 없습니다.");
  } finally {
    await db.close();
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

  const likeEscape = "ESCAPE '\\\\'";

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
