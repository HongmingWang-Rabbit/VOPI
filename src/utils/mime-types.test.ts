/**
 * MIME Types Utility Tests
 */

import { describe, it, expect } from 'vitest';
import {
  getAudioMimeType,
  getVideoMimeType,
  getImageMimeType,
  getMediaMimeType,
  isAudioMimeType,
  isVideoMimeType,
  isImageMimeType,
} from './mime-types.js';

describe('mime-types utility', () => {
  describe('getAudioMimeType', () => {
    it('should return correct MIME type for mp3', () => {
      expect(getAudioMimeType('/path/to/audio.mp3')).toBe('audio/mp3');
    });

    it('should return correct MIME type for wav', () => {
      expect(getAudioMimeType('/path/to/audio.wav')).toBe('audio/wav');
    });

    it('should return correct MIME type for aac', () => {
      expect(getAudioMimeType('/path/to/audio.aac')).toBe('audio/aac');
    });

    it('should return correct MIME type for m4a', () => {
      expect(getAudioMimeType('/path/to/audio.m4a')).toBe('audio/mp4');
    });

    it('should return correct MIME type for ogg', () => {
      expect(getAudioMimeType('/path/to/audio.ogg')).toBe('audio/ogg');
    });

    it('should return correct MIME type for flac', () => {
      expect(getAudioMimeType('/path/to/audio.flac')).toBe('audio/flac');
    });

    it('should return correct MIME type for weba', () => {
      expect(getAudioMimeType('/path/to/audio.weba')).toBe('audio/webm');
    });

    it('should handle uppercase extensions', () => {
      expect(getAudioMimeType('/path/to/audio.MP3')).toBe('audio/mp3');
    });

    it('should return default for unknown extension', () => {
      expect(getAudioMimeType('/path/to/audio.xyz')).toBe('audio/mp3');
    });

    it('should allow custom default type', () => {
      expect(getAudioMimeType('/path/to/audio.xyz', 'audio/wav')).toBe('audio/wav');
    });

    it('should handle files without extension', () => {
      expect(getAudioMimeType('/path/to/audio')).toBe('audio/mp3');
    });
  });

  describe('getVideoMimeType', () => {
    it('should return correct MIME type for mp4', () => {
      expect(getVideoMimeType('/path/to/video.mp4')).toBe('video/mp4');
    });

    it('should return correct MIME type for mov', () => {
      expect(getVideoMimeType('/path/to/video.mov')).toBe('video/quicktime');
    });

    it('should return correct MIME type for webm', () => {
      expect(getVideoMimeType('/path/to/video.webm')).toBe('video/webm');
    });

    it('should return correct MIME type for avi', () => {
      expect(getVideoMimeType('/path/to/video.avi')).toBe('video/x-msvideo');
    });

    it('should return correct MIME type for mkv', () => {
      expect(getVideoMimeType('/path/to/video.mkv')).toBe('video/x-matroska');
    });

    it('should return default for unknown extension', () => {
      expect(getVideoMimeType('/path/to/video.xyz')).toBe('video/mp4');
    });
  });

  describe('getImageMimeType', () => {
    it('should return correct MIME type for jpg', () => {
      expect(getImageMimeType('/path/to/image.jpg')).toBe('image/jpeg');
    });

    it('should return correct MIME type for jpeg', () => {
      expect(getImageMimeType('/path/to/image.jpeg')).toBe('image/jpeg');
    });

    it('should return correct MIME type for png', () => {
      expect(getImageMimeType('/path/to/image.png')).toBe('image/png');
    });

    it('should return correct MIME type for gif', () => {
      expect(getImageMimeType('/path/to/image.gif')).toBe('image/gif');
    });

    it('should return correct MIME type for webp', () => {
      expect(getImageMimeType('/path/to/image.webp')).toBe('image/webp');
    });

    it('should return correct MIME type for avif', () => {
      expect(getImageMimeType('/path/to/image.avif')).toBe('image/avif');
    });

    it('should return correct MIME type for svg', () => {
      expect(getImageMimeType('/path/to/image.svg')).toBe('image/svg+xml');
    });

    it('should return default for unknown extension', () => {
      expect(getImageMimeType('/path/to/image.xyz')).toBe('image/png');
    });
  });

  describe('getMediaMimeType', () => {
    it('should detect audio file', () => {
      expect(getMediaMimeType('/path/to/file.mp3')).toBe('audio/mp3');
    });

    it('should detect video file', () => {
      expect(getMediaMimeType('/path/to/file.mp4')).toBe('video/mp4');
    });

    it('should detect image file', () => {
      expect(getMediaMimeType('/path/to/file.png')).toBe('image/png');
    });

    it('should return default for unknown extension', () => {
      expect(getMediaMimeType('/path/to/file.xyz')).toBe('application/octet-stream');
    });
  });

  describe('MIME type checks', () => {
    it('isAudioMimeType should identify audio types', () => {
      expect(isAudioMimeType('audio/mp3')).toBe(true);
      expect(isAudioMimeType('audio/wav')).toBe(true);
      expect(isAudioMimeType('video/mp4')).toBe(false);
      expect(isAudioMimeType('image/png')).toBe(false);
    });

    it('isVideoMimeType should identify video types', () => {
      expect(isVideoMimeType('video/mp4')).toBe(true);
      expect(isVideoMimeType('video/webm')).toBe(true);
      expect(isVideoMimeType('audio/mp3')).toBe(false);
      expect(isVideoMimeType('image/png')).toBe(false);
    });

    it('isImageMimeType should identify image types', () => {
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('audio/mp3')).toBe(false);
      expect(isImageMimeType('video/mp4')).toBe(false);
    });
  });
});
