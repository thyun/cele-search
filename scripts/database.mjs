import mysql from "mysql2/promise";

export function getMysqlConfig() {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "cele_search",
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: true,
  };
}

export function toMysqlDateTime(value) {
  if (value === null || value === undefined || value === "") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

class MysqlPreparedStatement {
  constructor(connection, sql) {
    this.connection = connection;
    this.sql = sql;
  }

  async all(...args) {
    const [rows] = await this.connection.execute(this.sql, args.flat());
    return rows;
  }

  async get(...args) {
    const [rows] = await this.connection.execute(this.sql, args.flat());
    return rows[0] ?? undefined;
  }

  async run(...args) {
    const [result] = await this.connection.execute(this.sql, args.flat());
    return {
      changes: Number(result.affectedRows ?? 0),
      lastInsertRowid: Number(result.insertId ?? 0),
    };
  }
}

class MysqlDatabase {
  constructor(connection) {
    this.connection = connection;
  }

  prepare(sql) {
    return new MysqlPreparedStatement(this.connection, sql);
  }

  async exec(sql) {
    const statement = sql.trim();
    if (/^BEGIN\b/i.test(statement)) {
      await this.connection.beginTransaction();
      return;
    }
    if (/^COMMIT\b/i.test(statement)) {
      await this.connection.commit();
      return;
    }
    if (/^ROLLBACK\b/i.test(statement)) {
      await this.connection.rollback();
      return;
    }
    await this.connection.query(statement);
  }

  async close() {
    await this.connection.end();
  }
}

export async function openDatabase(options = {}) {
  const connection = await mysql.createConnection(getMysqlConfig());
  if (options.readOnly) {
    await connection.execute("SET SESSION TRANSACTION READ ONLY");
  }
  return new MysqlDatabase(connection);
}

async function mysqlInitializeDatabase(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS excluded_channels (
      channel_id VARCHAR(255) PRIMARY KEY,
      title VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS channels (
      channel_id VARCHAR(255) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      subscriber_count BIGINT NULL,
      uploads_playlist_id VARCHAR(255) NULL,
      discovered_keyword VARCHAR(255) NULL,
      discovered_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      is_approved TINYINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS videos (
      video_id VARCHAR(255) PRIMARY KEY,
      channel_id VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      published_at DATETIME(3) NOT NULL,
      thumbnail_url TEXT NULL,
      duration_seconds INT NOT NULL,
      view_count BIGINT NOT NULL,
      like_count BIGINT NOT NULL,
      comment_count BIGINT NOT NULL,
      efficiency_score DOUBLE NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      is_short TINYINT NOT NULL DEFAULT 0,
      CONSTRAINT fk_videos_channel FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  `);

  const [existingIndex] = await connection.query(
    "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'videos' AND index_name = 'idx_videos_score' LIMIT 1",
  );
  if (existingIndex.length === 0) {
    await connection.query("CREATE INDEX idx_videos_score ON videos (efficiency_score DESC)");
  }

  const [channelColumns] = await connection.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'channels'",
  );
  if (!channelColumns.some((column) => column.name === "is_approved")) {
    await connection.query("ALTER TABLE channels ADD COLUMN is_approved TINYINT NOT NULL DEFAULT 0");
  }
  await connection.query("UPDATE channels SET is_approved = 1 WHERE is_approved IS NULL");

  const [videoColumns] = await connection.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'videos'",
  );

  if (!videoColumns.some((column) => column.name === "created_at")) {
    await connection.query("ALTER TABLE videos ADD COLUMN created_at DATETIME(3) NULL");
    await connection.query("UPDATE videos SET created_at = updated_at WHERE created_at IS NULL");
  }

  if (!videoColumns.some((column) => column.name === "is_short")) {
    await connection.query("ALTER TABLE videos ADD COLUMN is_short TINYINT NOT NULL DEFAULT 0");
    await connection.query(`UPDATE videos SET is_short = CASE WHEN duration_seconds > 0 AND duration_seconds <= 180 THEN 1 ELSE 0 END WHERE is_short IS NULL OR is_short NOT IN (0,1)`);
  }
}

export async function initializeDatabase(db) {
  await mysqlInitializeDatabase(db.connection);
}
