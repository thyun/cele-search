/**
 * Manual batch: discover channels via search.list, then collect each channel's
 * recent videos (including Shorts candidates) and rank them by views relative
 * to subscribers.
 *
 * Usage:
 *   npm run batch:channels -- [--pages=2] [--keyword=추가키워드] [--skip-discover]
 *   npm run batch:videos
 *   npm run batch -- [--pages=2] [--keyword=추가키워드] [--skip-discover] (both)
 *
 * Quota (units): search.list 100/call, channels.list 1/50 channels,
 * playlistItems.list 1/channel, videos.list 1/50 videos.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDatabasePath, initializeDatabase, isMysqlEnabled, openDatabase, toMysqlDateTime } from "./database.mjs";
import { excludeChannel, isExcludedChannel, removeBroadcasters } from "./broadcasters.mjs";

const API = "https://www.googleapis.com/youtube/v3";
const DB_PATH = getDatabasePath();
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
const SHORTS_MAX_SECONDS = 3 * 60;
const MIN_SUBSCRIBERS = 1000; // floor so tiny/hidden-sub channels don't explode the ratio
const DEFAULT_KEYWORDS = [
  "연예인 추천템",
  "셀럽 PPL",
  "스타 협찬",
  "연예인 신제품 광고",
  "아이돌 광고 촬영",
];

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith("--") ? args.shift() : "all";
if (!["all", "channels", "videos"].includes(mode)) {
  throw new Error(`Unknown batch mode: ${mode}. Use channels or videos.`);
}
if (mode === "videos" && args.length > 0) {
  throw new Error("The videos batch takes no discovery options. Use npm run batch:channels instead.");
}
const pages = Number(
  args.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? 2,
);
const extraKeywords = args
  .filter((a) => a.startsWith("--keyword="))
  .map((a) => a.slice("--keyword=".length).trim())
  .filter(Boolean);
const skipDiscover = args.includes("--skip-discover");

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey || apiKey === "your_youtube_data_api_v3_key_here") {
  console.error("YOUTUBE_API_KEY is not set. Add it to .env first.");
  process.exit(1);
}

let quota = 0;
async function call(endpoint, params, cost) {
  const qs = new URLSearchParams({ key: apiKey, ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`);
  if (!res.ok) {
    throw new Error(`${endpoint} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  quota += cost;
  return res.json();
}

function parseDuration(iso) {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

async function main() {
  if (!isMysqlEnabled()) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  const db = await openDatabase();
  await initializeDatabase(db);
  const removed = await removeBroadcasters(db);
  console.log(`excluded ${removed.channels} broadcaster channels and ${removed.videos} videos`);

  const now = toMysqlDateTime(new Date());
  const cutoff = toMysqlDateTime(new Date(Date.now() - SIX_MONTHS_MS));

  async function discoverChannels() {
    const keywords = [...extraKeywords.map((k) => `${k} 광고`), ...DEFAULT_KEYWORDS];
    const found = new Map(); // channelId -> keyword
    for (const keyword of keywords) {
      let pageToken;
      for (let i = 0; i < pages; i++) {
        const params = {
          q: keyword, part: "snippet", type: "video", order: "viewCount",
          publishedAfter: cutoff, maxResults: "50", relevanceLanguage: "ko",
        };
        if (pageToken) params.pageToken = pageToken;
        const data = await call("search", params, 100);
        for (const item of data.items ?? []) {
          const id = item.snippet?.channelId;
          const title = item.snippet?.channelTitle ?? "";
          if (id && !isExcludedChannel(db, id, title) && !found.has(id)) found.set(id, keyword);
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
      console.log(`discovered via "${keyword}": ${found.size} channels so far`);
    }

    const insertSql = isMysqlEnabled()
      ? `INSERT IGNORE INTO channels (channel_id, title, discovered_keyword, discovered_at, updated_at) VALUES (?, '', ?, ?, ?)`
      : `INSERT INTO channels (channel_id, title, discovered_keyword, discovered_at, updated_at) VALUES (?, '', ?, ?, ?) ON CONFLICT(channel_id) DO NOTHING`;
    const insert = db.prepare(insertSql);
    for (const [id, keyword] of found) await insert.run(id, keyword, now, now);
  }

  async function refreshChannels() {
    const ids = (await db.prepare("SELECT channel_id FROM channels").all()).map((r) => r.channel_id);
    const update = db.prepare(
      `UPDATE channels SET title = ?, subscriber_count = ?, uploads_playlist_id = ?, updated_at = ?
       WHERE channel_id = ?`,
    );
    for (const batch of chunk(ids, 50)) {
      const data = await call(
        "channels", { id: batch.join(","), part: "snippet,statistics,contentDetails" }, 1,
      );
      for (const ch of data.items ?? []) {
        const title = ch.snippet?.title ?? "";
        if (isExcludedChannel(db, ch.id, title)) {
          const videos = await excludeChannel(db, ch.id, title);
          console.log(`excluded broadcaster ${title} (${ch.id}), removed ${videos} videos`);
          continue;
        }
        const subs = ch.statistics?.hiddenSubscriberCount
          ? null
          : Number(ch.statistics?.subscriberCount ?? 0);
        await update.run(
          title, subs,
          ch.contentDetails?.relatedPlaylists?.uploads ?? null, now, ch.id,
        );
      }
    }
    console.log(`refreshed ${ids.length} channels`);
  }

  async function collectVideos() {
    const channels = await db
      .prepare("SELECT channel_id, subscriber_count, uploads_playlist_id FROM channels WHERE uploads_playlist_id IS NOT NULL")
      .all();
    const subsByChannel = new Map(channels.map((c) => [c.channel_id, c.subscriber_count]));

    const videoIds = [];
    for (const ch of channels) {
      try {
        const data = await call(
          "playlistItems",
          { playlistId: ch.uploads_playlist_id, part: "contentDetails", maxResults: "30" },
          1,
        );
        for (const item of data.items ?? []) {
          const published = item.contentDetails?.videoPublishedAt;
          if (published && published >= cutoff) videoIds.push(item.contentDetails.videoId);
        }
      } catch (error) {
        console.warn(`skip channel ${ch.channel_id}: ${error.message}`);
      }
    }

    const upsertSql = isMysqlEnabled()
      ? `INSERT INTO videos (video_id, channel_id, title, published_at, thumbnail_url, duration_seconds,
          view_count, like_count, comment_count, efficiency_score, created_at, updated_at, is_short)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), thumbnail_url = VALUES(thumbnail_url),
           view_count = VALUES(view_count), like_count = VALUES(like_count),
           comment_count = VALUES(comment_count), efficiency_score = VALUES(efficiency_score),
           duration_seconds = VALUES(duration_seconds), is_short = VALUES(is_short),
           created_at = IFNULL(videos.created_at, VALUES(created_at)),
           updated_at = VALUES(updated_at)`
      : `INSERT INTO videos (video_id, channel_id, title, published_at, thumbnail_url, duration_seconds,
          view_count, like_count, comment_count, efficiency_score, created_at, updated_at, is_short)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           title = excluded.title, thumbnail_url = excluded.thumbnail_url,
           view_count = excluded.view_count, like_count = excluded.like_count,
           comment_count = excluded.comment_count, efficiency_score = excluded.efficiency_score,
           duration_seconds = excluded.duration_seconds, is_short = excluded.is_short,
           created_at = COALESCE(videos.created_at, excluded.created_at),
           updated_at = excluded.updated_at`;
    const upsert = db.prepare(upsertSql);
    let saved = 0;
    let shorts = 0;
    for (const batch of chunk([...new Set(videoIds)], 50)) {
      const data = await call(
        "videos", { id: batch.join(","), part: "snippet,contentDetails,statistics" }, 1,
      );
      for (const v of data.items ?? []) {
        const duration = parseDuration(v.contentDetails?.duration ?? "");
        if (duration <= 0) continue;
        // Public API metadata cannot confirm Shorts; duration identifies candidates only.
        const isShort = duration <= SHORTS_MAX_SECONDS ? 1 : 0;
        const views = Number(v.statistics?.viewCount ?? 0);
        const subs = Math.max(subsByChannel.get(v.snippet.channelId) ?? 0, MIN_SUBSCRIBERS);
        await upsert.run(
          v.id, v.snippet.channelId, v.snippet.title, toMysqlDateTime(v.snippet.publishedAt),
          v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? "",
          duration, views, Number(v.statistics?.likeCount ?? 0),
          Number(v.statistics?.commentCount ?? 0), views / subs, now, now, isShort,
        );
        saved++;
        shorts += isShort;
      }
    }
    const pruned = await db.prepare("DELETE FROM videos WHERE published_at < ?").run(cutoff);
    console.log(`saved ${saved} videos (${shorts} Shorts candidates), pruned ${pruned.changes} old ones`);
  }

  try {
    if (mode !== "videos" && !skipDiscover) await discoverChannels();
    await refreshChannels();
    if (mode !== "channels") await collectVideos();
    console.log(`done (${mode}). estimated quota used: ${quota} units. db: ${DB_PATH}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
