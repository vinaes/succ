import { StorageDispatcherBase } from './base.js';

export class SkillsDispatcherMixin extends StorageDispatcherBase {
  async upsertSkill(skill: {
    name: string;
    description: string;
    source: 'local' | 'skyll';
    path?: string;
    content?: string;
    skyllId?: string;
    cacheExpires?: string;
  }): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.upsertSkill({
        ...skill,
        cacheExpires: skill.cacheExpires ? new Date(skill.cacheExpires) : undefined,
      });
    }
    const { upsertSkill } = await import('../../db/skills.js');
    return upsertSkill(skill);
  }

  async getAllSkills(): Promise<
    Array<{
      id: number;
      name: string;
      description: string;
      source: string;
      path?: string;
      content?: string;
      skyllId?: string;
      usageCount: number;
      lastUsed?: string;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllSkills();
      return rows.map((r) => ({
        ...r,
        lastUsed: r.lastUsed ? String(r.lastUsed) : undefined,
        usageCount: r.usageCount,
      }));
    }
    const { getAllSkills } = await import('../../db/skills.js');
    const rows = getAllSkills();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      path: r.path,
      content: r.content,
      skyllId: r.skyll_id,
      usageCount: r.usage_count ?? 0,
      lastUsed: r.last_used,
    }));
  }

  async searchSkills(
    query: string,
    limit: number = 10
  ): Promise<
    Array<{
      id: number;
      name: string;
      description: string;
      source: string;
      path?: string;
      usageCount: number;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchSkills(query, limit);
    const { searchSkills } = await import('../../db/skills.js');
    const rows = searchSkills(query, limit);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      path: r.path,
      usageCount: r.usage_count ?? 0,
    }));
  }

  async getSkillByName(name: string): Promise<{
    id: number;
    name: string;
    description: string;
    source: string;
    path?: string;
    content?: string;
    skyllId?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getSkillByName(name);
    const { getSkillByName } = await import('../../db/skills.js');
    const row = getSkillByName(name);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      path: row.path,
      content: row.content,
      skyllId: row.skyll_id,
    };
  }

  async trackSkillUsage(name: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.trackSkillUsage(name);
    const { trackSkillUsage } = await import('../../db/skills.js');
    trackSkillUsage(name);
  }

  async deleteSkill(name: string): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteSkill(name);
    const { deleteSkill } = await import('../../db/skills.js');
    return deleteSkill(name);
  }

  async clearExpiredSkyllCache(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.clearExpiredSkyllCache();
    const { clearExpiredSkyllCache } = await import('../../db/skills.js');
    return clearExpiredSkyllCache();
  }

  async getCachedSkyllSkill(skyllId: string): Promise<{
    id: number;
    name: string;
    description: string;
    content?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getCachedSkyllSkill(skyllId);
    const { getCachedSkyllSkill } = await import('../../db/skills.js');
    return getCachedSkyllSkill(skyllId);
  }

  async getSkyllCacheStats(): Promise<{ cachedSkills: number }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getSkyllCacheStats();
    const { getSkyllCacheStats } = await import('../../db/skills.js');
    return getSkyllCacheStats();
  }

  // ===========================================================================
  // Bulk Export (for checkpoint, graph-export)
  // ===========================================================================
}
