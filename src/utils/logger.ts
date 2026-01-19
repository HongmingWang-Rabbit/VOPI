import pino, { type Logger } from 'pino';
import { getConfig } from '../config/index.js';

let logger: Logger | null = null;

/**
 * Create or get the application logger
 */
export function getLogger(): Logger {
  if (logger) {
    return logger;
  }

  const config = getConfig();
  const isDev = config.server.env === 'development';

  logger = pino.default({
    level: config.logging.level,
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      service: 'vopi-backend',
      env: config.server.env,
    },
  });

  return logger;
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: Record<string, unknown>): Logger {
  return getLogger().child(context);
}
