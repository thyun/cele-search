import { isMysqlEnabled } from "./database.mjs";

// Match broadcaster brands, not generic words such as "news" or "TV".
const BRAND_PATTERN = /(?:^|[^a-z])(?:kbs|mbc|sbs|ebs|jtbc|mbn|ytn|tvn|mnet|tvchosun|channela|obs|kbc|knn|tbc|tjb|cjb|ubc|jtv|g1)(?=$|[^a-z]|news|world|drama|entertainment|ent|sports|star|official|plus|story|show|music|digital|life|every1|on)/i;
const KOREAN_BRANDS = /한국방송공사|문화방송|에스비에스|한국교육방송|제이티비씨|채널\s*에이|채널\s*a|티비\s*조선|tv\s*조선|조선방송|매일방송|연합뉴스|티비엔|엠넷|엠비씨|케이비에스|이비에스|와이티엔|스브스|케이엔엔|경인방송/i;

export function isBroadcaster(title) {
  const normalized = title.normalize("NFKC");
  return BRAND_PATTERN.test(normalized) || KOREAN_BRANDS.test(normalized);
}

export function isExcludedChannel(db, channelId, title) {
  return isBroadcaster(title) ||
    Boolean(db.prepare("SELECT 1 FROM excluded_channels WHERE channel_id = ?").get(channelId));
}

export function excludeChannel(db, channelId, title) {
  db.exec("BEGIN");
  try {
    if (isMysqlEnabled()) {
      db.prepare(`
        INSERT INTO excluded_channels (channel_id, title)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE title = VALUES(title)
      `).run(channelId, title);
    } else {
      db.prepare(`
        INSERT INTO excluded_channels (channel_id, title) VALUES (?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET title = excluded.title
      `).run(channelId, title);
    }
    const videos = db.prepare("DELETE FROM videos WHERE channel_id = ?").run(channelId).changes;
    db.prepare("DELETE FROM channels WHERE channel_id = ?").run(channelId);
    db.exec("COMMIT");
    return Number(videos);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function removeBroadcasters(db) {
  let channels = 0;
  let videos = 0;
  for (const channel of db.prepare("SELECT channel_id, title FROM channels").all()) {
    if (isExcludedChannel(db, channel.channel_id, channel.title)) {
      videos += excludeChannel(db, channel.channel_id, channel.title);
      channels++;
    }
  }
  return { channels, videos };
}
