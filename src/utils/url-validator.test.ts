import { describe, it, expect, vi } from 'vitest';
import {
  isCallbackUrlAllowed,
  isSafeProtocol,
  isPrivateUrl,
  validateCallbackUrlComprehensive,
} from './url-validator.js';

// Mock the config module
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    callback: {
      allowedDomains: ['example.com', 'api.myservice.io'],
    },
    server: {
      env: 'production',
    },
  })),
}));

describe('url-validator', () => {
  describe('isSafeProtocol', () => {
    it('should return true for http URLs', () => {
      expect(isSafeProtocol('http://example.com')).toBe(true);
    });

    it('should return true for https URLs', () => {
      expect(isSafeProtocol('https://example.com')).toBe(true);
    });

    it('should return false for ftp URLs', () => {
      expect(isSafeProtocol('ftp://example.com')).toBe(false);
    });

    it('should return false for file URLs', () => {
      expect(isSafeProtocol('file:///etc/passwd')).toBe(false);
    });

    it('should return false for javascript URLs', () => {
      expect(isSafeProtocol('javascript:alert(1)')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(isSafeProtocol('not-a-url')).toBe(false);
    });
  });

  describe('isPrivateUrl', () => {
    it('should return true for localhost', () => {
      expect(isPrivateUrl('http://localhost')).toBe(true);
      expect(isPrivateUrl('http://localhost:3000')).toBe(true);
    });

    it('should return true for 127.0.0.1', () => {
      expect(isPrivateUrl('http://127.0.0.1')).toBe(true);
      expect(isPrivateUrl('http://127.0.0.1:8080')).toBe(true);
    });

    it('should return true for IPv6 localhost', () => {
      expect(isPrivateUrl('http://[::1]')).toBe(true);
    });

    it('should return true for 10.x.x.x range', () => {
      expect(isPrivateUrl('http://10.0.0.1')).toBe(true);
      expect(isPrivateUrl('http://10.255.255.255')).toBe(true);
    });

    it('should return true for 172.16-31.x.x range', () => {
      expect(isPrivateUrl('http://172.16.0.1')).toBe(true);
      expect(isPrivateUrl('http://172.31.255.255')).toBe(true);
    });

    it('should return false for 172.15.x.x (not private)', () => {
      expect(isPrivateUrl('http://172.15.0.1')).toBe(false);
    });

    it('should return false for 172.32.x.x (not private)', () => {
      expect(isPrivateUrl('http://172.32.0.1')).toBe(false);
    });

    it('should return true for 192.168.x.x range', () => {
      expect(isPrivateUrl('http://192.168.0.1')).toBe(true);
      expect(isPrivateUrl('http://192.168.1.100')).toBe(true);
    });

    it('should return true for 169.254.x.x (link-local)', () => {
      expect(isPrivateUrl('http://169.254.1.1')).toBe(true);
    });

    it('should return false for public IPs', () => {
      expect(isPrivateUrl('http://8.8.8.8')).toBe(false);
      expect(isPrivateUrl('http://1.1.1.1')).toBe(false);
      expect(isPrivateUrl('https://example.com')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(isPrivateUrl('not-a-url')).toBe(false);
    });
  });

  describe('isCallbackUrlAllowed', () => {
    it('should allow exact domain match', () => {
      expect(isCallbackUrlAllowed('https://example.com/webhook')).toBe(true);
      expect(isCallbackUrlAllowed('https://api.myservice.io/callback')).toBe(true);
    });

    it('should allow subdomain match', () => {
      expect(isCallbackUrlAllowed('https://api.example.com/webhook')).toBe(true);
      expect(isCallbackUrlAllowed('https://sub.api.example.com/webhook')).toBe(true);
    });

    it('should reject non-allowed domains', () => {
      expect(isCallbackUrlAllowed('https://evil.com/steal')).toBe(false);
      expect(isCallbackUrlAllowed('https://notexample.com/webhook')).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(isCallbackUrlAllowed('not-a-url')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isCallbackUrlAllowed('https://EXAMPLE.COM/webhook')).toBe(true);
      expect(isCallbackUrlAllowed('https://Example.Com/webhook')).toBe(true);
    });
  });

  describe('validateCallbackUrlComprehensive', () => {
    it('should return valid for allowed https URL', () => {
      const result = validateCallbackUrlComprehensive('https://example.com/webhook');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject non-http/https protocols', () => {
      const result = validateCallbackUrlComprehensive('ftp://example.com/file');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('http or https');
    });

    it('should reject private IPs in production', () => {
      const result = validateCallbackUrlComprehensive('http://192.168.1.1/webhook');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('private');
    });

    it('should reject non-allowed domains', () => {
      const result = validateCallbackUrlComprehensive('https://evil.com/steal');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });
  });
});
