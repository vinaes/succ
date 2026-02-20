/**
 * Tests for per-action profile gating (profile.ts)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setResolvedProfile, getResolvedProfile, gateAction } from './profile.js';

describe('profile gating', () => {
  afterEach(() => {
    // Reset to default after each test
    setResolvedProfile('full');
  });

  describe('setResolvedProfile / getResolvedProfile', () => {
    it('defaults to full', () => {
      setResolvedProfile('full');
      expect(getResolvedProfile()).toBe('full');
    });

    it('stores core profile', () => {
      setResolvedProfile('core');
      expect(getResolvedProfile()).toBe('core');
    });

    it('stores standard profile', () => {
      setResolvedProfile('standard');
      expect(getResolvedProfile()).toBe('standard');
    });
  });

  describe('gateAction', () => {
    describe('full profile — nothing gated', () => {
      it('allows succ_status stats', () => {
        setResolvedProfile('full');
        expect(gateAction('succ_status', 'stats')).toBeNull();
      });

      it('allows succ_config checkpoint_create', () => {
        setResolvedProfile('full');
        expect(gateAction('succ_config', 'checkpoint_create')).toBeNull();
      });

      it('allows succ_web deep', () => {
        setResolvedProfile('full');
        expect(gateAction('succ_web', 'deep')).toBeNull();
      });

      it('allows succ_fetch __extract', () => {
        setResolvedProfile('full');
        expect(gateAction('succ_fetch', '__extract')).toBeNull();
      });
    });

    describe('core profile — gates standard+ actions', () => {
      it('gates succ_status stats (requires standard)', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_status', 'stats');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
        expect(result!.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('requires "standard" profile'),
        });
      });

      it('gates succ_status score (requires standard)', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_status', 'score');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
      });

      it('gates succ_fetch __extract (requires standard)', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_fetch', '__extract');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
        expect(result!.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('requires "standard" profile'),
        });
      });

      it('gates succ_config checkpoint_create (requires full)', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_config', 'checkpoint_create');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
        expect(result!.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('requires "full" profile'),
        });
      });

      it('gates succ_web deep (requires full)', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_web', 'deep');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
        expect(result!.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('requires "full" profile'),
        });
      });
    });

    describe('standard profile — gates full-only actions', () => {
      it('allows succ_status stats (requires standard)', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_status', 'stats')).toBeNull();
      });

      it('allows succ_status score (requires standard)', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_status', 'score')).toBeNull();
      });

      it('allows succ_fetch __extract (requires standard)', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_fetch', '__extract')).toBeNull();
      });

      it('gates succ_config checkpoint_create (requires full)', () => {
        setResolvedProfile('standard');
        const result = gateAction('succ_config', 'checkpoint_create');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
        expect(result!.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('requires "full" profile'),
        });
      });

      it('gates succ_config checkpoint_list (requires full)', () => {
        setResolvedProfile('standard');
        const result = gateAction('succ_config', 'checkpoint_list');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
      });

      it('gates succ_web deep (requires full)', () => {
        setResolvedProfile('standard');
        const result = gateAction('succ_web', 'deep');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
      });

      it('gates succ_web history (requires full)', () => {
        setResolvedProfile('standard');
        const result = gateAction('succ_web', 'history');
        expect(result).not.toBeNull();
        expect(result!.isError).toBe(true);
      });
    });

    describe('ungated actions — always allowed', () => {
      it('allows succ_status overview at core', () => {
        setResolvedProfile('core');
        expect(gateAction('succ_status', 'overview')).toBeNull();
      });

      it('allows succ_config show at standard', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_config', 'show')).toBeNull();
      });

      it('allows succ_config set at standard', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_config', 'set')).toBeNull();
      });

      it('allows succ_web search at standard', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_web', 'search')).toBeNull();
      });

      it('allows succ_web quick at standard', () => {
        setResolvedProfile('standard');
        expect(gateAction('succ_web', 'quick')).toBeNull();
      });
    });

    describe('unknown tools/actions — always allowed', () => {
      it('allows unknown tool', () => {
        setResolvedProfile('core');
        expect(gateAction('succ_unknown', 'anything')).toBeNull();
      });

      it('allows unknown action on gated tool', () => {
        setResolvedProfile('core');
        expect(gateAction('succ_status', 'nonexistent')).toBeNull();
      });
    });

    describe('error response format', () => {
      it('includes upgrade instructions', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_status', 'stats')!;
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('succ_config(action="set", key="tool_profile"');
        expect(text).toContain('value="standard"');
      });

      it('shows current profile in message', () => {
        setResolvedProfile('core');
        const result = gateAction('succ_web', 'deep')!;
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('current: "core"');
        expect(text).toContain('value="full"');
      });
    });
  });
});
