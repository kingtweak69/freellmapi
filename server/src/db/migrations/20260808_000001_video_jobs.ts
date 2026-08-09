import type { Db } from '../types.js';

export const id = '20260808_000001_video_jobs';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      upstream_id TEXT NOT NULL,
      media_model_id INTEGER NOT NULL REFERENCES media_models(id) ON DELETE CASCADE,
      key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON video_jobs(created_at);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS video_jobs');
}
