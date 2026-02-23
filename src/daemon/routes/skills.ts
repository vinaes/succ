import {
  EmptyBodySchema,
  parseRequestBody,
  SkillsSuggestSchema,
  SkillsTrackSchema,
  type RouteContext,
  type RouteMap,
} from './types.js';

export function skillRoutes(ctx: RouteContext): RouteMap {
  return {
    'POST /api/skills/suggest': async (body) => {
      const { prompt, limit = 2 } = parseRequestBody(
        SkillsSuggestSchema,
        body,
        'prompt required'
      );

      const { suggestSkills, getSkillsConfig } = await import('../../lib/skills.js');
      const config = getSkillsConfig();

      if (!config.enabled || !config.auto_suggest?.enabled) {
        return { success: true, skills: [], disabled: true };
      }

      const suggestions = await suggestSkills(prompt, config);
      return {
        success: true,
        skills: suggestions.slice(0, limit),
      };
    },

    'POST /api/skills/index': async (body) => {
      parseRequestBody(EmptyBodySchema, body);
      const { indexLocalSkills } = await import('../../lib/skills.js');
      const cwd = ctx.state?.cwd || process.cwd();
      const count = indexLocalSkills(cwd);
      return { success: true, indexed: count };
    },

    'POST /api/skills/track': async (body) => {
      const { skill_name } = parseRequestBody(SkillsTrackSchema, body, 'skill_name required');
      const { trackSkillUsage } = await import('../../lib/skills.js');
      trackSkillUsage(skill_name);
      return { success: true };
    },

    'GET /api/skills/skyll': async () => {
      const { getSkyllStatus } = await import('../../lib/skyll-client.js');
      return getSkyllStatus();
    },
  };
}
