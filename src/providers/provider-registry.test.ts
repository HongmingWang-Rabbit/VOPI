import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRegistry } from './provider-registry.js';
import type { BackgroundRemovalProvider } from './interfaces/background-removal.provider.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  // Mock providers
  const mockBgProvider1: BackgroundRemovalProvider = {
    providerId: 'provider-1',
    removeBackground: vi.fn().mockResolvedValue({ success: true, outputPath: '/output.png' }),
    isAvailable: vi.fn().mockReturnValue(true),
  };

  const mockBgProvider2: BackgroundRemovalProvider = {
    providerId: 'provider-2',
    removeBackground: vi.fn().mockResolvedValue({ success: true, outputPath: '/output.png' }),
    isAvailable: vi.fn().mockReturnValue(false),
  };

  beforeEach(() => {
    registry = new ProviderRegistry();
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('should register a provider', () => {
      registry.register('backgroundRemoval', mockBgProvider1);

      const { provider, providerId } = registry.get('backgroundRemoval');
      expect(provider).toBe(mockBgProvider1);
      expect(providerId).toBe('provider-1');
    });

    it('should set first registered provider as default', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);

      const { providerId } = registry.get('backgroundRemoval');
      expect(providerId).toBe('provider-1');
    });

    it('should allow setting a provider as default during registration', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2, true);

      const { providerId } = registry.get('backgroundRemoval');
      expect(providerId).toBe('provider-2');
    });

    it('should throw for unknown provider type', () => {
      expect(() => {
        // @ts-expect-error Testing invalid type
        registry.register('unknownType', mockBgProvider1);
      }).toThrow('Unknown provider type');
    });
  });

  describe('get', () => {
    beforeEach(() => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);
    });

    it('should return the default provider when no ID specified', () => {
      const { provider, providerId } = registry.get('backgroundRemoval');
      expect(providerId).toBe('provider-1');
      expect(provider).toBe(mockBgProvider1);
    });

    it('should return a specific provider by ID', () => {
      const { provider, providerId } = registry.get('backgroundRemoval', 'provider-2');
      expect(providerId).toBe('provider-2');
      expect(provider).toBe(mockBgProvider2);
    });

    it('should throw when no providers registered for type', () => {
      expect(() => registry.get('classification')).toThrow('No providers registered');
    });

    it('should throw when specific provider not found', () => {
      expect(() => registry.get('backgroundRemoval', 'non-existent')).toThrow('Provider not found');
    });
  });

  describe('setDefault', () => {
    it('should change the default provider', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);

      registry.setDefault('backgroundRemoval', 'provider-2');

      const { providerId } = registry.get('backgroundRemoval');
      expect(providerId).toBe('provider-2');
    });

    it('should throw when setting non-existent provider as default', () => {
      registry.register('backgroundRemoval', mockBgProvider1);

      expect(() => registry.setDefault('backgroundRemoval', 'non-existent')).toThrow('Provider not found');
    });
  });

  describe('A/B testing', () => {
    beforeEach(() => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);
    });

    it('should configure an A/B test', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 50,
        active: true,
      });

      // With a seed, should return one of the A/B variants
      const result = registry.get('backgroundRemoval', undefined, 'seed-123');
      expect(result.abTestId).toBe('test-1');
      expect(['A', 'B']).toContain(result.variant);
    });

    it('should return consistent variant for same seed', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 50,
        active: true,
      });

      const result1 = registry.get('backgroundRemoval', undefined, 'consistent-seed');
      const result2 = registry.get('backgroundRemoval', undefined, 'consistent-seed');

      expect(result1.variant).toBe(result2.variant);
      expect(result1.providerId).toBe(result2.providerId);
    });

    it('should not apply A/B test when inactive', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 50,
        active: false,
      });

      const result = registry.get('backgroundRemoval', undefined, 'seed-123');
      expect(result.abTestId).toBeUndefined();
      expect(result.variant).toBeUndefined();
    });

    it('should not apply A/B test without seed', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 50,
        active: true,
      });

      const result = registry.get('backgroundRemoval');
      expect(result.abTestId).toBeUndefined();
    });

    it('should disable A/B test', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 50,
        active: true,
      });

      registry.disableABTest('backgroundRemoval');

      const result = registry.get('backgroundRemoval', undefined, 'seed-123');
      expect(result.abTestId).toBeUndefined();
    });

    it('should throw when configuring A/B test with non-existent provider A', () => {
      expect(() =>
        registry.configureABTest('backgroundRemoval', {
          testId: 'test-1',
          providerA: 'non-existent',
          providerB: 'provider-2',
          trafficPercentA: 50,
          active: true,
        })
      ).toThrow('Provider A not found');
    });

    it('should throw when configuring A/B test with non-existent provider B', () => {
      expect(() =>
        registry.configureABTest('backgroundRemoval', {
          testId: 'test-1',
          providerA: 'provider-1',
          providerB: 'non-existent',
          trafficPercentA: 50,
          active: true,
        })
      ).toThrow('Provider B not found');
    });

    it('should respect traffic percentage', () => {
      registry.configureABTest('backgroundRemoval', {
        testId: 'test-1',
        providerA: 'provider-1',
        providerB: 'provider-2',
        trafficPercentA: 100,
        active: true,
      });

      // With 100% traffic to A, should always get provider-1
      for (let i = 0; i < 10; i++) {
        const result = registry.get('backgroundRemoval', undefined, `seed-${i}`);
        expect(result.variant).toBe('A');
        expect(result.providerId).toBe('provider-1');
      }
    });
  });

  describe('getAll', () => {
    it('should return all registered providers for a type', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);

      const all = registry.getAll('backgroundRemoval');
      expect(all.size).toBe(2);
      expect(all.get('provider-1')).toBe(mockBgProvider1);
      expect(all.get('provider-2')).toBe(mockBgProvider2);
    });
  });

  describe('hasProviders', () => {
    it('should return true when providers are registered', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      expect(registry.hasProviders('backgroundRemoval')).toBe(true);
    });

    it('should return false when no providers registered', () => {
      expect(registry.hasProviders('backgroundRemoval')).toBe(false);
    });
  });

  describe('getAvailable', () => {
    it('should return only available providers', () => {
      registry.register('backgroundRemoval', mockBgProvider1);
      registry.register('backgroundRemoval', mockBgProvider2);

      const available = registry.getAvailable('backgroundRemoval');
      expect(available).toHaveLength(1);
      expect(available[0]).toBe(mockBgProvider1);
    });

    it('should return empty array when no providers registered', () => {
      const available = registry.getAvailable('classification');
      expect(available).toHaveLength(0);
    });
  });
});
