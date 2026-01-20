import { input, confirm, select } from '@inquirer/prompts';
import path from 'path';

import { storageService } from '../../services/storage.service.js';
import { getConfig } from '../../config/index.js';
import {
  printHeader,
  printStep,
  printSuccess,
  printError,
  printInfo,
  printLabel,
  printDivider,
  printRaw,
  formatFileSize,
  listFilesWithSizes,
  Timer,
  isValidFile,
  isValidDirectory,
  PRESIGN_EXPIRATION_SECONDS,
} from './utils.js';

/**
 * Test the Upload step of the pipeline
 * Uploads files to S3/MinIO storage
 */
export async function testUpload(): Promise<{
  success: boolean;
  uploadedUrls?: string[];
}> {
  printHeader('Test Upload Step (S3/MinIO)');

  // Check configuration
  let config;
  try {
    config = getConfig();
  } catch {
    printError('Failed to load configuration. Make sure .env file exists.');
    return { success: false };
  }

  printInfo('Storage Configuration:');
  printLabel('  Bucket', config.storage.bucket);
  printLabel('  Region', config.storage.region);
  if (config.storage.endpoint) {
    printLabel('  Endpoint', config.storage.endpoint);
  }
  printDivider();

  // Initialize storage service
  printStep(1, 'Initializing storage service...');
  try {
    storageService.init();
    printSuccess('Storage service initialized');
  } catch (error) {
    printError(`Failed to initialize storage: ${(error as Error).message}`);
    return { success: false };
  }

  // Select upload mode
  const uploadMode = await select({
    message: 'Select upload mode:',
    choices: [
      { name: 'Upload a single file', value: 'single' },
      { name: 'Upload all files from a directory', value: 'directory' },
      { name: 'Generate presigned upload URL', value: 'presign' },
    ],
  });

  if (uploadMode === 'presign') {
    return testPresignedUrl();
  }

  if (uploadMode === 'single') {
    return testSingleUpload();
  }

  return testDirectoryUpload();
}

/**
 * Test single file upload
 */
async function testSingleUpload(): Promise<{ success: boolean; uploadedUrls?: string[] }> {
  const filePath = await input({
    message: 'Enter path to file to upload:',
    validate: async (value) => {
      if (!value.trim()) return 'File path is required';
      const isFile = await isValidFile(value);
      if (!isFile) return 'File not found';
      return true;
    },
  });

  const jobId = await input({
    message: 'Enter job ID for S3 key path:',
    default: `test-${Date.now()}`,
  });

  const subPath = await input({
    message: 'Enter sub-path within job (e.g., "frames", "commercial"):',
    default: 'test',
  });

  const filename = path.basename(filePath);
  const s3Key = storageService.getJobKey(jobId, subPath, filename);

  printDivider();
  printInfo('Upload Configuration:');
  printLabel('  Local File', filePath);
  printLabel('  S3 Key', s3Key);
  printDivider();

  const proceed = await confirm({
    message: 'Proceed with upload?',
    default: true,
  });

  if (!proceed) {
    printInfo('Upload cancelled');
    return { success: false };
  }

  const timer = new Timer();

  try {
    printStep(2, 'Uploading file...');
    const result = await storageService.uploadFile(filePath, s3Key);

    printSuccess(`Upload completed in ${timer.elapsedFormatted()}`);
    printDivider();
    printInfo('Upload Result:');
    printLabel('  Key', result.key);
    printLabel('  URL', result.url);
    printLabel('  Size', formatFileSize(result.size));

    return { success: true, uploadedUrls: [result.url] };
  } catch (error) {
    printError(`Upload failed: ${(error as Error).message}`);
    return { success: false };
  }
}

/**
 * Test directory upload
 */
async function testDirectoryUpload(): Promise<{ success: boolean; uploadedUrls?: string[] }> {
  const dirPath = await input({
    message: 'Enter path to directory to upload:',
    validate: async (value) => {
      if (!value.trim()) return 'Directory path is required';
      const isDir = await isValidDirectory(value);
      if (!isDir) return 'Directory not found';
      return true;
    },
  });

  const jobId = await input({
    message: 'Enter job ID for S3 key path:',
    default: `test-${Date.now()}`,
  });

  const subPath = await input({
    message: 'Enter sub-path within job (e.g., "frames", "commercial"):',
    default: 'test',
  });

  // List files in directory
  const files = await listFilesWithSizes(dirPath);

  if (files.length === 0) {
    printError('No files found in directory');
    return { success: false };
  }

  printDivider();
  printInfo(`Found ${files.length} files to upload:`);
  for (const file of files.slice(0, 10)) {
    printLabel(`  ${file.name}`, formatFileSize(file.size));
  }
  if (files.length > 10) {
    printInfo(`  ... and ${files.length - 10} more files`);
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  printLabel('  Total size', formatFileSize(totalSize));
  printDivider();

  const proceed = await confirm({
    message: `Upload ${files.length} files?`,
    default: true,
  });

  if (!proceed) {
    printInfo('Upload cancelled');
    return { success: false };
  }

  const timer = new Timer();
  const uploadedUrls: string[] = [];
  let successCount = 0;
  let failCount = 0;

  printStep(2, 'Uploading files...');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const s3Key = storageService.getJobKey(jobId, subPath, file.name);

    try {
      const result = await storageService.uploadFile(file.path, s3Key);
      uploadedUrls.push(result.url);
      successCount++;

      if ((i + 1) % 10 === 0 || i === files.length - 1) {
        printInfo(`  Progress: ${i + 1}/${files.length} files`);
      }
    } catch (error) {
      failCount++;
      printError(`  Failed to upload ${file.name}: ${(error as Error).message}`);
    }
  }

  printDivider();
  printSuccess(`Upload completed in ${timer.elapsedFormatted()}`);
  printLabel('  Successful', successCount);
  printLabel('  Failed', failCount);

  if (uploadedUrls.length > 0) {
    printDivider();
    printInfo('Sample URLs:');
    for (const url of uploadedUrls.slice(0, 5)) {
      printRaw(`  ${url}`);
    }
    if (uploadedUrls.length > 5) {
      printInfo(`  ... and ${uploadedUrls.length - 5} more`);
    }
  }

  return { success: successCount > 0, uploadedUrls };
}

/**
 * Test presigned URL generation
 */
async function testPresignedUrl(): Promise<{ success: boolean }> {
  printHeader('Generate Presigned Upload URL');

  const filename = await input({
    message: 'Enter filename for upload:',
    default: 'test-video.mp4',
  });

  const contentType = await select({
    message: 'Select content type:',
    choices: [
      { name: 'video/mp4', value: 'video/mp4' },
      { name: 'video/quicktime', value: 'video/quicktime' },
      { name: 'image/png', value: 'image/png' },
      { name: 'image/jpeg', value: 'image/jpeg' },
      { name: 'application/octet-stream', value: 'application/octet-stream' },
    ],
  });

  const s3Key = `uploads/${Date.now()}_${filename}`;

  printDivider();
  printInfo('Presigned URL Configuration:');
  printLabel('  Filename', filename);
  printLabel('  Content-Type', contentType);
  printLabel('  S3 Key', s3Key);
  printLabel('  Expires In', `${PRESIGN_EXPIRATION_SECONDS} seconds`);
  printDivider();

  try {
    printStep(2, 'Generating presigned URL...');
    const result = await storageService.getPresignedUploadUrl(s3Key, contentType, PRESIGN_EXPIRATION_SECONDS);

    printSuccess('Presigned URL generated');
    printDivider();
    printInfo('Result:');
    printLabel('  Upload URL', result.uploadUrl.substring(0, 100) + '...');
    printLabel('  Key', result.key);
    printLabel('  Public URL', result.publicUrl);

    printDivider();
    printInfo('To upload using curl:');
    printRaw(`  curl -X PUT -H "Content-Type: ${contentType}" --data-binary @<file> "${result.uploadUrl}"`);

    return { success: true };
  } catch (error) {
    printError(`Failed to generate presigned URL: ${(error as Error).message}`);
    return { success: false };
  }
}

/**
 * Test download from S3
 */
export async function testS3Download(): Promise<{ success: boolean }> {
  printHeader('Test S3 Download');

  const s3Key = await input({
    message: 'Enter S3 key to download:',
    validate: (value) => (value.trim() ? true : 'S3 key is required'),
  });

  const outputPath = await input({
    message: 'Enter output path:',
    default: `/tmp/${path.basename(s3Key)}`,
  });

  const timer = new Timer();

  try {
    printStep(1, 'Initializing storage service...');
    storageService.init();

    printStep(2, 'Downloading file...');
    await storageService.downloadFile(s3Key, outputPath);

    printSuccess(`Download completed in ${timer.elapsedFormatted()}`);
    printLabel('  Output', outputPath);

    return { success: true };
  } catch (error) {
    printError(`Download failed: ${(error as Error).message}`);
    return { success: false };
  }
}

/**
 * Test S3 operations menu
 */
export async function testS3Operations(): Promise<{ success: boolean }> {
  printHeader('S3 Operations');

  const operation = await select({
    message: 'Select operation:',
    choices: [
      { name: 'Upload file(s)', value: 'upload' },
      { name: 'Download file', value: 'download' },
      { name: 'Generate presigned URL', value: 'presign' },
      { name: 'List files in prefix', value: 'list' },
      { name: 'Check if file exists', value: 'exists' },
      { name: 'Delete file', value: 'delete' },
    ],
  });

  switch (operation) {
    case 'upload':
      return testUpload();
    case 'download':
      return testS3Download();
    case 'presign':
      return testPresignedUrl();
    case 'list':
      return testListFiles();
    case 'exists':
      return testFileExists();
    case 'delete':
      return testDeleteFile();
    default:
      return { success: false };
  }
}

async function testListFiles(): Promise<{ success: boolean }> {
  const prefix = await input({
    message: 'Enter S3 prefix to list:',
    default: 'jobs/',
  });

  try {
    storageService.init();
    const files = await storageService.listFiles(prefix);

    printDivider();
    printInfo(`Found ${files.length} files:`);
    for (const file of files.slice(0, 20)) {
      printRaw(`  ${file}`);
    }
    if (files.length > 20) {
      printInfo(`  ... and ${files.length - 20} more`);
    }

    return { success: true };
  } catch (error) {
    printError(`List failed: ${(error as Error).message}`);
    return { success: false };
  }
}

async function testFileExists(): Promise<{ success: boolean }> {
  const s3Key = await input({
    message: 'Enter S3 key to check:',
  });

  try {
    storageService.init();
    const exists = await storageService.exists(s3Key);
    printInfo(`File ${exists ? 'exists' : 'does not exist'}`);
    return { success: true };
  } catch (error) {
    printError(`Check failed: ${(error as Error).message}`);
    return { success: false };
  }
}

async function testDeleteFile(): Promise<{ success: boolean }> {
  const s3Key = await input({
    message: 'Enter S3 key to delete:',
  });

  const proceed = await confirm({
    message: `Are you sure you want to delete ${s3Key}?`,
    default: false,
  });

  if (!proceed) {
    printInfo('Delete cancelled');
    return { success: false };
  }

  try {
    storageService.init();
    await storageService.deleteFile(s3Key);
    printSuccess('File deleted');
    return { success: true };
  } catch (error) {
    printError(`Delete failed: ${(error as Error).message}`);
    return { success: false };
  }
}
