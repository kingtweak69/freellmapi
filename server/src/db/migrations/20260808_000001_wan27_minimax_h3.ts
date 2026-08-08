import type { Db } from '../types.js';

const TARGET_MODELS = [
  {
    platform: 'openrouter',
    modelId: 'alibaba/wan-2.7',
    displayName: 'Wan 2.7',
    intelligenceRank: 4,
    speedRank: 9,
    sizeLabel: 'Frontier',
    rpmLimit: 20,
    rpdLimit: 200,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: '~6M',
    contextWindow: 131072,
    enabled: 1,
    supportsVision: 1,
    supportsTools: 0,
  },
  {
    platform: 'openrouter',
    modelId: 'minimax/minimax-h3',
    displayName: 'MiniMax H3',
    intelligenceRank: 3,
    speedRank: 9,
    sizeLabel: 'Frontier',
    rpmLimit: 20,
    rpdLimit: 200,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: '~6M',
    contextWindow: 131072,
    enabled: 1,
    supportsVision: 0,
    supportsTools: 1,
  },
] as const;

/**
 * Seed Wan 2.7 and MiniMax H3 catalog rows so installs can route them
 * immediately, even before the next signed catalog refresh arrives.
 */
export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, supports_vision, supports_tools, source
    ) VALUES (
      @platform, @modelId, @displayName, @intelligenceRank, @speedRank, @sizeLabel,
      @rpmLimit, @rpdLimit, @tpmLimit, @tpdLimit, @monthlyTokenBudget, @contextWindow,
      @enabled, @supportsVision, @supportsTools, 'catalog'
    )
  `);
  const selectMissingFallback = db.prepare(`
    SELECT m.id
      FROM models m
      LEFT JOIN fallback_config f ON f.model_db_id = m.id
     WHERE m.platform = ? AND m.model_id = ? AND f.id IS NULL
     ORDER BY m.id ASC
  `);
  const selectMaxFallbackPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM fallback_config');
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');

  const selectProfiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC');
  const selectMissingProfileRows = db.prepare(`
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE m.platform = ? AND m.model_id = ? AND pm.id IS NULL
     ORDER BY f.priority, m.id
  `);
  const selectMaxProfilePriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?');
  const insertProfileRow = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

  const apply = db.transaction(() => {
    for (const model of TARGET_MODELS) {
      insertModel.run(model);
    }

    let nextPriority = (selectMaxFallbackPriority.get() as { max_priority: number }).max_priority + 1;
    for (const model of TARGET_MODELS) {
      const missingFallbackRows = selectMissingFallback.all(model.platform, model.modelId) as { id: number }[];
      for (const row of missingFallbackRows) {
        insertFallback.run(row.id, nextPriority++);
      }
    }

    const profiles = selectProfiles.all() as { id: number }[];
    for (const profile of profiles) {
      let nextProfilePriority = (selectMaxProfilePriority.get(profile.id) as { max_priority: number }).max_priority + 1;
      for (const model of TARGET_MODELS) {
        const missingProfileRows = selectMissingProfileRows.all(profile.id, model.platform, model.modelId) as { id: number; enabled: number }[];
        for (const row of missingProfileRows) {
          insertProfileRow.run(profile.id, row.id, nextProfilePriority++, row.enabled);
        }
      }
    }
  });

  apply();
}

export function down(db: Db): void {
  const rows = db.prepare(`
    SELECT id
      FROM models
     WHERE source = 'catalog'
       AND (
         (platform = 'openrouter' AND model_id = 'alibaba/wan-2.7')
         OR
         (platform = 'openrouter' AND model_id = 'minimax/minimax-h3')
       )
  `).all() as { id: number }[];

  if (rows.length === 0) return;

  const deleteProfileRows = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
  const deleteFallbackRows = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');

  const revert = db.transaction(() => {
    for (const row of rows) {
      deleteProfileRows.run(row.id);
      deleteFallbackRows.run(row.id);
      deleteModel.run(row.id);
    }
  });

  revert();
}
