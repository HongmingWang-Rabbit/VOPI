import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger().child({ service: 'encryption' });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
/** Maximum derived keys to cache (uses FIFO eviction) */
const CACHE_MAX_SIZE = 10;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Cached derived key entry
 * Note: Cache uses FIFO eviction when full, which is acceptable because:
 * 1. Small cache size (10) with long TTL (1 hour) means most keys stay cached
 * 2. Key derivation is deterministic, so cache misses just re-derive
 * 3. True LRU would add complexity without significant benefit
 */
interface CachedKey {
  key: Buffer;
  createdAt: number;
}

/**
 * Encryption service for secure token storage
 * Uses AES-256-GCM for authenticated encryption
 *
 * Key derivation strategy:
 * - If TOKEN_ENCRYPTION_KEY is exactly 32 bytes (64 hex chars or 32 raw), use directly
 * - Otherwise, derive using scrypt with a deployment-specific salt
 *
 * Format: Version(1) + Salt(32) + IV(16) + AuthTag(16) + Ciphertext
 * Version 1 = scrypt-derived key with random salt per ciphertext
 * Version 0 = legacy format (no salt prefix, fixed zero salt)
 */
class EncryptionService {
  private keyCache: Map<string, CachedKey> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Counter to track legacy format decryptions for migration monitoring */
  private legacyFormatCount: number = 0;

  constructor() {
    this.startCleanup();
  }

  /**
   * Start periodic cache cleanup
   */
  private startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.keyCache.entries()) {
        if (now - cached.createdAt > CACHE_TTL_MS) {
          this.keyCache.delete(key);
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    // Allow process to exit
    this.cleanupInterval.unref?.();
  }

  /**
   * Get config key source
   */
  private getKeySource(): string {
    const config = getConfig();
    const keySource = config.encryption.tokenKey;

    if (!keySource) {
      throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    }

    return keySource;
  }

  /**
   * Derive encryption key from source and salt
   */
  private deriveKey(keySource: string, salt: Buffer): Buffer {
    // Create cache key from source hash + salt
    const cacheKey = createHash('sha256')
      .update(keySource)
      .update(salt)
      .digest('hex');

    // Check cache
    const cached = this.keyCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return cached.key;
    }

    // Derive key using scrypt
    const derivedKey = scryptSync(keySource, salt, KEY_LENGTH, {
      N: 16384, // CPU/memory cost
      r: 8,     // Block size
      p: 1,     // Parallelization
    });

    // Cache with size limit
    if (this.keyCache.size >= CACHE_MAX_SIZE) {
      // Remove oldest entry
      const oldestKey = this.keyCache.keys().next().value;
      if (oldestKey) this.keyCache.delete(oldestKey);
    }

    this.keyCache.set(cacheKey, {
      key: derivedKey,
      createdAt: Date.now(),
    });

    return derivedKey;
  }

  /**
   * Get key for legacy format (version 0)
   * Uses zero salt for backwards compatibility
   */
  private getLegacyKey(): Buffer {
    const keySource = this.getKeySource();
    const keyBuffer = Buffer.from(keySource, 'utf-8');

    // Direct use if exactly 32 bytes
    if (keyBuffer.length === KEY_LENGTH) {
      return keyBuffer;
    }

    // Derive with zero salt (legacy behavior)
    const zeroSalt = Buffer.alloc(SALT_LENGTH, 0);
    return this.deriveKey(keySource, zeroSalt);
  }

  /**
   * Encrypt plaintext using AES-256-GCM
   * Returns base64-encoded string: Version(1) + Salt(32) + IV(16) + AuthTag(16) + Ciphertext
   */
  encrypt(plaintext: string): string {
    const keySource = this.getKeySource();

    // Generate random salt for this encryption
    const salt = randomBytes(SALT_LENGTH);
    const key = this.deriveKey(keySource, salt);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Version 1 format: Version + Salt + IV + AuthTag + Ciphertext
    const version = Buffer.from([0x01]);
    const combined = Buffer.concat([version, salt, iv, authTag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt ciphertext encrypted with encrypt()
   * Supports both legacy (version 0) and current (version 1) formats
   */
  decrypt(ciphertext: string): string {
    const combined = Buffer.from(ciphertext, 'base64');

    // Check version byte
    const version = combined[0];

    if (version === 0x01) {
      // Version 1: Salt + IV + AuthTag + Ciphertext
      const salt = combined.subarray(1, 1 + SALT_LENGTH);
      const iv = combined.subarray(1 + SALT_LENGTH, 1 + SALT_LENGTH + IV_LENGTH);
      const authTag = combined.subarray(
        1 + SALT_LENGTH + IV_LENGTH,
        1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
      );
      const encrypted = combined.subarray(1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

      const keySource = this.getKeySource();
      const key = this.deriveKey(keySource, salt);

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    }

    // Legacy format (version 0): IV + AuthTag + Ciphertext
    // The first byte happens to be part of the IV, not a version marker
    logger.warn(
      'Decrypting legacy v0 format ciphertext - consider re-encrypting with current format'
    );
    this.legacyFormatCount++;

    const key = this.getLegacyKey();
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  }

  /**
   * Check if encryption is configured
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!config.encryption.tokenKey;
  }

  /**
   * Clear the key cache (useful for testing)
   */
  clearCache(): void {
    this.keyCache.clear();
  }

  /**
   * Get the count of legacy format decryptions since service start
   * Useful for monitoring migration progress
   */
  getLegacyFormatCount(): number {
    return this.legacyFormatCount;
  }

  /**
   * Reset the legacy format counter (useful for testing)
   */
  resetLegacyFormatCount(): void {
    this.legacyFormatCount = 0;
  }

  /**
   * Check if a ciphertext is in legacy (v0) format
   */
  isLegacyFormat(ciphertext: string): boolean {
    try {
      const combined = Buffer.from(ciphertext, 'base64');
      return combined[0] !== 0x01;
    } catch {
      return false;
    }
  }

  /**
   * Migrate a ciphertext from legacy v0 format to current v1 format
   * Returns the re-encrypted ciphertext in v1 format
   */
  migrate(ciphertext: string): string {
    if (!this.isLegacyFormat(ciphertext)) {
      // Already in current format, return as-is
      return ciphertext;
    }

    // Decrypt with legacy format and re-encrypt with current format
    const plaintext = this.decrypt(ciphertext);
    const migrated = this.encrypt(plaintext);

    logger.info('Migrated ciphertext from v0 to v1 format');
    return migrated;
  }
}

export const encryptionService = new EncryptionService();
