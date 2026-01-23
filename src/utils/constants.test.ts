/**
 * Constants Utility Tests
 */

import { describe, it, expect } from 'vitest';
import { APP_VERSION, APP_NAME, PIPELINE_VERSION } from './constants.js';

describe('constants utility', () => {
  describe('APP_VERSION', () => {
    it('should be a valid semver string', () => {
      expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should match package.json version', () => {
      // The version should be 2.0.0 based on package.json
      expect(APP_VERSION).toBe('2.0.0');
    });
  });

  describe('APP_NAME', () => {
    it('should be defined', () => {
      expect(APP_NAME).toBeDefined();
      expect(typeof APP_NAME).toBe('string');
    });

    it('should match package.json name', () => {
      expect(APP_NAME).toBe('vopi-backend');
    });
  });

  describe('PIPELINE_VERSION', () => {
    it('should equal APP_VERSION', () => {
      expect(PIPELINE_VERSION).toBe(APP_VERSION);
    });

    it('should be a valid semver string', () => {
      expect(PIPELINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
