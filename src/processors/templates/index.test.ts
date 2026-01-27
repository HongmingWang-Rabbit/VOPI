import { describe, it, expect } from 'vitest';
import {
  getDefaultStackId,
  getStackTemplate,
  getStackTemplateIds,
  stackTemplates,
} from './index.js';
import { PipelineStrategy } from '../../types/config.types.js';

describe('Stack Templates', () => {
  describe('getDefaultStackId', () => {
    it('should return "classic" for classic strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.CLASSIC)).toBe('classic');
    });

    it('should return "gemini_video" for gemini_video strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.GEMINI_VIDEO)).toBe('gemini_video');
    });

    it('should return "unified_video_analyzer" for unified_video_analyzer strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.UNIFIED_VIDEO_ANALYZER)).toBe('unified_video_analyzer');
    });

    it('should return "full_gemini" for full_gemini strategy', () => {
      expect(getDefaultStackId(PipelineStrategy.FULL_GEMINI)).toBe('full_gemini');
    });

    it('should return the strategy directly if it matches a valid template', () => {
      expect(getDefaultStackId('minimal')).toBe('minimal');
      expect(getDefaultStackId('frames_only')).toBe('frames_only');
      expect(getDefaultStackId('stability_bg_removal')).toBe('stability_bg_removal');
    });

    it('should fall back to "classic" for unknown strategies', () => {
      expect(getDefaultStackId('unknown_strategy')).toBe('classic');
      expect(getDefaultStackId('')).toBe('classic');
      expect(getDefaultStackId('does_not_exist')).toBe('classic');
    });
  });

  describe('getStackTemplate', () => {
    it('should return the correct template for valid IDs', () => {
      const classic = getStackTemplate('classic');
      expect(classic).toBeDefined();
      expect(classic?.id).toBe('classic');
      expect(classic?.name).toBe('Classic Pipeline');

      const fullGemini = getStackTemplate('full_gemini');
      expect(fullGemini).toBeDefined();
      expect(fullGemini?.id).toBe('full_gemini');
      expect(fullGemini?.name).toBe('Full Gemini Stack');
    });

    it('should return undefined for invalid IDs', () => {
      expect(getStackTemplate('invalid')).toBeUndefined();
      expect(getStackTemplate('')).toBeUndefined();
    });
  });

  describe('getStackTemplateIds', () => {
    it('should return all available template IDs', () => {
      const ids = getStackTemplateIds();
      expect(ids).toContain('classic');
      expect(ids).toContain('gemini_video');
      expect(ids).toContain('minimal');
      expect(ids).toContain('full_gemini');
      expect(ids).toContain('unified_video_analyzer');
    });

    it('should match the keys of stackTemplates', () => {
      const ids = getStackTemplateIds();
      expect(ids.sort()).toEqual(Object.keys(stackTemplates).sort());
    });
  });

  describe('stackTemplates', () => {
    it('should have all expected templates', () => {
      const expectedTemplates = [
        'classic',
        'gemini_video',
        'minimal',
        'frames_only',
        'custom_bg_removal',
        'full_product_analysis',
        'audio_metadata_only',
        'stability_bg_removal',
        'unified_video_analyzer',
        'unified_video_analyzer_minimal',
        'full_gemini',
      ];

      for (const templateId of expectedTemplates) {
        expect(stackTemplates[templateId]).toBeDefined();
        expect(stackTemplates[templateId].id).toBe(templateId);
      }
    });

    it('should have valid steps in each template', () => {
      for (const [id, template] of Object.entries(stackTemplates)) {
        expect(template.steps.length).toBeGreaterThan(0);
        for (const step of template.steps) {
          expect(step.processor).toBeDefined();
          expect(typeof step.processor).toBe('string');
        }
      }
    });
  });
});
