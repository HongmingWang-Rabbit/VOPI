import { writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import https from 'https';

import { createChildLogger } from '../utils/logger.js';
import { ExternalApiError } from '../utils/errors.js';
import { getConfig } from '../config/index.js';
import type { RecommendedFrame } from './gemini.service.js';
import type { FrameObstructions, BackgroundRecommendations } from '../types/job.types.js';

const logger = createChildLogger({ service: 'photoroom' });

const PHOTOROOM_BASIC_URL = 'sdk.photoroom.com';
const PHOTOROOM_BASIC_ENDPOINT = '/v1/segment';
const PHOTOROOM_PLUS_URL = 'image-api.photoroom.com';
const PHOTOROOM_EDIT_ENDPOINT = '/v2/edit';

export interface ProcessResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  method?: string;
  bgColor?: string;
  bgPrompt?: string;
  error?: string;
}

export interface AllVersionsResult {
  frameId: string;
  recommendedType: string;
  versions: Record<string, ProcessResult>;
}

/**
 * PhotoroomService - Photoroom API integration
 * Ported from smartFrameExtractor/photoroom.js
 */
export class PhotoroomService {
  /**
   * Build removal prompt based on obstruction types
   */
  private buildRemovalPrompt(obstructions: FrameObstructions | null): string | null {
    if (!obstructions?.has_obstruction || obstructions.obstruction_types.length === 0) {
      return null;
    }

    const typeDescriptions: Record<string, string> = {
      hand: 'human hands and fingers',
      finger: 'fingers',
      arm: 'human arms',
      cord: 'cords and cables',
      tag: 'price tags and labels',
      reflection: 'unwanted reflections',
      shadow: 'harsh shadows',
      other_object: 'foreign objects',
    };

    const items = obstructions.obstruction_types
      .map((t) => typeDescriptions[t] || t)
      .join(', ');

    return `Erase ONLY the ${items} from this image. DO NOT modify, change, or alter the product in any way. The product must remain pixel-perfect identical. Replace the removed areas with transparent background only.`;
  }

  /**
   * Make HTTP request to Photoroom API
   */
  private makeRequest(
    options: https.RequestOptions,
    buildBody: (
      req: ReturnType<typeof https.request>,
      boundary: string
    ) => Promise<void>
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const contentType = res.headers['content-type'] || '';
        const isImage = contentType.includes('image/');

        if (!isImage) {
          let errorData = '';
          res.on('data', (chunk: Buffer) => {
            errorData += chunk.toString();
          });
          res.on('end', () => {
            reject(
              new ExternalApiError(
                'Photoroom',
                `API error (${res.statusCode}): ${errorData}`
              )
            );
          });
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });

      req.on('error', (err) => {
        reject(new ExternalApiError('Photoroom', `Request failed: ${err.message}`));
      });

      const boundary = '--------------------------' + Date.now().toString(16);
      req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);

      buildBody(req, boundary).catch(reject);
    });
  }

  /**
   * Add form field to multipart request
   */
  private addField(
    req: ReturnType<typeof https.request>,
    boundary: string,
    name: string,
    value: string
  ): void {
    req.write(`--${boundary}\r\n`);
    req.write(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    req.write(`${value}\r\n`);
  }

  /**
   * Stream file to multipart request
   */
  private async streamFile(
    req: ReturnType<typeof https.request>,
    boundary: string,
    imagePath: string
  ): Promise<void> {
    const filename = path.basename(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    req.write(`--${boundary}\r\n`);
    req.write(
      `Content-Disposition: form-data; name="imageFile"; filename="${filename}"\r\n`
    );
    req.write(`Content-Type: ${mimeType}\r\n\r\n`);

    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(imagePath);

      fileStream.on('end', () => {
        req.write('\r\n');
        req.write(`--${boundary}--\r\n`);
        req.end();
        resolve();
      });

      fileStream.on('error', reject);
      fileStream.pipe(req, { end: false });
    });
  }

  /**
   * Edit image with AI modifications
   */
  async editImageWithAI(
    imagePath: string,
    outputPath: string,
    options: { obstructions?: FrameObstructions | null; customPrompt?: string } = {}
  ): Promise<ProcessResult> {
    const config = getConfig();
    const { obstructions = null, customPrompt = null } = options;

    const prompt =
      customPrompt ||
      this.buildRemovalPrompt(obstructions) ||
      'Erase any human hands, fingers, or arms from this image. DO NOT modify the product in any way. Replace removed areas with transparent background only.';

    logger.info({ imagePath: path.basename(imagePath) }, 'Editing image with AI');

    const imageBuffer = await this.makeRequest(
      {
        hostname: PHOTOROOM_PLUS_URL,
        path: PHOTOROOM_EDIT_ENDPOINT,
        method: 'POST',
        headers: {
          'x-api-key': config.apis.photoroom,
        },
      },
      async (req, boundary) => {
        this.addField(req, boundary, 'removeBackground', 'true');
        this.addField(req, boundary, 'outputFormat', 'png');
        this.addField(req, boundary, 'describeAnyChange.mode', 'ai.auto');
        this.addField(req, boundary, 'describeAnyChange.prompt', prompt);
        await this.streamFile(req, boundary, imagePath);
      }
    );

    await writeFile(outputPath, imageBuffer);
    logger.info({ outputPath: path.basename(outputPath) }, 'AI edit saved');

    return {
      success: true,
      outputPath,
      size: imageBuffer.length,
      method: 'v2/edit',
    };
  }

  /**
   * Generate image with solid color background
   */
  async generateWithSolidBackground(
    imagePath: string,
    outputPath: string,
    bgColor: string
  ): Promise<ProcessResult> {
    const config = getConfig();

    logger.info({ imagePath: path.basename(imagePath), bgColor }, 'Generating with solid background');

    const imageBuffer = await this.makeRequest(
      {
        hostname: PHOTOROOM_PLUS_URL,
        path: PHOTOROOM_EDIT_ENDPOINT,
        method: 'POST',
        headers: {
          'x-api-key': config.apis.photoroom,
        },
      },
      async (req, boundary) => {
        this.addField(req, boundary, 'removeBackground', 'true');
        this.addField(req, boundary, 'outputFormat', 'png');
        this.addField(req, boundary, 'background.color', bgColor);
        this.addField(req, boundary, 'padding', '0.12');
        await this.streamFile(req, boundary, imagePath);
      }
    );

    await writeFile(outputPath, imageBuffer);
    logger.info({ outputPath: path.basename(outputPath) }, 'Solid background saved');

    return {
      success: true,
      outputPath,
      size: imageBuffer.length,
      method: 'solid_background',
      bgColor,
    };
  }

  /**
   * Generate image with AI-generated background
   */
  async generateWithAIBackground(
    imagePath: string,
    outputPath: string,
    bgPrompt: string
  ): Promise<ProcessResult> {
    const config = getConfig();

    logger.info({ imagePath: path.basename(imagePath) }, 'Generating with AI background');

    const imageBuffer = await this.makeRequest(
      {
        hostname: PHOTOROOM_PLUS_URL,
        path: PHOTOROOM_EDIT_ENDPOINT,
        method: 'POST',
        headers: {
          'x-api-key': config.apis.photoroom,
        },
      },
      async (req, boundary) => {
        this.addField(req, boundary, 'removeBackground', 'true');
        this.addField(req, boundary, 'outputFormat', 'png');
        this.addField(req, boundary, 'background.prompt', bgPrompt);
        this.addField(req, boundary, 'padding', '0.12');
        await this.streamFile(req, boundary, imagePath);
      }
    );

    await writeFile(outputPath, imageBuffer);
    logger.info({ outputPath: path.basename(outputPath) }, 'AI background saved');

    return {
      success: true,
      outputPath,
      size: imageBuffer.length,
      method: 'ai_background',
      bgPrompt,
    };
  }

  /**
   * Remove background (basic v1/segment)
   */
  async removeBackground(imagePath: string, outputPath: string): Promise<ProcessResult> {
    const config = getConfig();

    logger.info({ imagePath: path.basename(imagePath) }, 'Removing background');

    const imageBuffer = await this.makeRequest(
      {
        hostname: PHOTOROOM_BASIC_URL,
        path: PHOTOROOM_BASIC_ENDPOINT,
        method: 'POST',
        headers: {
          'x-api-key': config.apis.photoroom,
        },
      },
      async (req, boundary) => {
        const filename = path.basename(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

        req.write(`--${boundary}\r\n`);
        req.write(
          `Content-Disposition: form-data; name="image_file"; filename="${filename}"\r\n`
        );
        req.write(`Content-Type: ${mimeType}\r\n\r\n`);

        return new Promise<void>((resolve, reject) => {
          const fileStream = createReadStream(imagePath);
          fileStream.on('end', () => {
            req.write('\r\n');
            req.write(`--${boundary}--\r\n`);
            req.end();
            resolve();
          });
          fileStream.on('error', reject);
          fileStream.pipe(req, { end: false });
        });
      }
    );

    await writeFile(outputPath, imageBuffer);
    logger.info({ outputPath: path.basename(outputPath) }, 'Background removed');

    return {
      success: true,
      outputPath,
      size: imageBuffer.length,
    };
  }

  /**
   * Generate all commercial versions for a frame
   */
  async generateAllVersions(
    frame: RecommendedFrame,
    outputDir: string,
    options: {
      useAIEdit?: boolean;
      versions?: string[];
    } = {}
  ): Promise<AllVersionsResult> {
    const { useAIEdit = false, versions = ['transparent', 'solid', 'real', 'creative'] } = options;

    const baseName = `${frame.recommendedType}_${frame.frameId}`;
    const hasObstruction = frame.obstructions?.has_obstruction;
    const bgRec = frame.backgroundRecommendations || {
      solid_color: '#FFFFFF',
      real_life_setting: 'on a clean white surface with soft lighting',
      creative_shot: 'floating with soft shadow on gradient background',
    };

    const results: AllVersionsResult = {
      frameId: frame.frameId,
      recommendedType: frame.recommendedType,
      versions: {},
    };

    // 1. Generate transparent PNG first
    const transparentPath = path.join(outputDir, `${baseName}_transparent.png`);
    let transparentSuccess = false;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (useAIEdit && hasObstruction) {
          results.versions.transparent = await this.editImageWithAI(frame.path, transparentPath, {
            obstructions: frame.obstructions,
          });
        } else {
          results.versions.transparent = await this.removeBackground(frame.path, transparentPath);
        }
        transparentSuccess = results.versions.transparent?.success ?? false;
        if (transparentSuccess) break;
      } catch (err) {
        logger.error({ error: err, attempt }, 'Transparent generation failed');
        results.versions.transparent = { success: false, error: (err as Error).message };
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));

    if (hasObstruction && !transparentSuccess) {
      logger.error({ baseName }, 'Skipping other versions - transparent failed with obstructions');
      return results;
    }

    const sourceForBackgrounds = transparentSuccess ? transparentPath : frame.path;

    // 2. Solid color background
    if (versions.includes('solid')) {
      const outputPath = path.join(outputDir, `${baseName}_solid.png`);
      try {
        results.versions.solid = await this.generateWithSolidBackground(
          sourceForBackgrounds,
          outputPath,
          bgRec.solid_color
        );
      } catch (err) {
        results.versions.solid = { success: false, error: (err as Error).message };
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // 3. Real-life setting
    if (versions.includes('real')) {
      const outputPath = path.join(outputDir, `${baseName}_real.png`);
      try {
        results.versions.real = await this.generateWithAIBackground(
          sourceForBackgrounds,
          outputPath,
          bgRec.real_life_setting
        );
      } catch (err) {
        results.versions.real = { success: false, error: (err as Error).message };
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. Creative shot
    if (versions.includes('creative')) {
      const outputPath = path.join(outputDir, `${baseName}_creative.png`);
      try {
        results.versions.creative = await this.generateWithAIBackground(
          sourceForBackgrounds,
          outputPath,
          bgRec.creative_shot
        );
      } catch (err) {
        results.versions.creative = { success: false, error: (err as Error).message };
      }
    }

    // Remove transparent if not requested
    if (!versions.includes('transparent')) {
      delete results.versions.transparent;
    }

    return results;
  }
}

export const photoroomService = new PhotoroomService();
