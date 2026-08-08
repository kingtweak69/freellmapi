import type { Db } from '../types.js';

/**
 * Register Wan 2.7 in the media_models table as a video-generation model so
 * it appears on the new Video tab in the dashboard.
 *
 * The preceding migration (20260808_000001) seeded Wan 2.7 into the `models`
 * (chat) table by mistake — Wan 2.7 is a text-to-video model, not a chat
 * model.  This migration adds the correct media_models row.  The chat-table
 * row is left in place because it is harmless and removing it would
 * complicate the down() rollback.
 */
export function up(db: Db): void {
  db.prepare(`
    INSERT INTO media_models
      (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES
      ('openrouter', 'alibaba/wan-2.7', 'Wan 2.7', 'video', 1, 1, '')
    ON CONFLICT(platform, model_id) DO UPDATE SET enabled = 1
  `).run();
}

export function down(db: Db): void {
  db.prepare(`
    UPDATE media_models
       SET enabled = 0
     WHERE platform = 'openrouter'
       AND model_id = 'alibaba/wan-2.7'
       AND modality = 'video'
  `).run();
}
