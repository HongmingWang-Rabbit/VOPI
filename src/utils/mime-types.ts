/**
 * MIME Type Utilities
 *
 * Shared MIME type detection and mapping utilities.
 */

/**
 * Audio MIME types mapped from file extensions
 */
const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  webm: 'audio/webm',
};

/**
 * Video MIME types mapped from file extensions
 */
const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/mp4',
};

/**
 * Image MIME types mapped from file extensions
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/**
 * Get file extension from path (lowercase, without dot)
 */
function getExtension(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  return ext || '';
}

/**
 * Get MIME type for an audio file
 * @param filePath - Path to the audio file
 * @param defaultType - Default MIME type if extension not recognized (default: 'audio/mp3')
 * @returns MIME type string
 */
export function getAudioMimeType(filePath: string, defaultType = 'audio/mp3'): string {
  const ext = getExtension(filePath);
  return AUDIO_MIME_TYPES[ext] || defaultType;
}

/**
 * Get MIME type for a video file
 * @param filePath - Path to the video file
 * @param defaultType - Default MIME type if extension not recognized (default: 'video/mp4')
 * @returns MIME type string
 */
export function getVideoMimeType(filePath: string, defaultType = 'video/mp4'): string {
  const ext = getExtension(filePath);
  return VIDEO_MIME_TYPES[ext] || defaultType;
}

/**
 * Get MIME type for an image file
 * @param filePath - Path to the image file
 * @param defaultType - Default MIME type if extension not recognized (default: 'image/png')
 * @returns MIME type string
 */
export function getImageMimeType(filePath: string, defaultType = 'image/png'): string {
  const ext = getExtension(filePath);
  return IMAGE_MIME_TYPES[ext] || defaultType;
}

/**
 * Get MIME type for any supported media file
 * Checks audio, video, then image types
 * @param filePath - Path to the media file
 * @param defaultType - Default MIME type if extension not recognized (default: 'application/octet-stream')
 * @returns MIME type string
 */
export function getMediaMimeType(filePath: string, defaultType = 'application/octet-stream'): string {
  const ext = getExtension(filePath);
  return AUDIO_MIME_TYPES[ext] || VIDEO_MIME_TYPES[ext] || IMAGE_MIME_TYPES[ext] || defaultType;
}

/**
 * Check if a MIME type is an audio type
 */
export function isAudioMimeType(mimeType: string): boolean {
  return mimeType.startsWith('audio/');
}

/**
 * Check if a MIME type is a video type
 */
export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

/**
 * Check if a MIME type is an image type
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}
