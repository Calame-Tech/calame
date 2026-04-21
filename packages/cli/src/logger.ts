import type { LogLevel, LogFormat } from './config.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function formatText(
  level: LogLevel,
  msg: string,
  context: Record<string, unknown>,
  meta?: Record<string, unknown>,
): string {
  const component = context.component ? `[${context.component}]` : '';
  const extra = meta ? ' ' + JSON.stringify(meta) : '';
  return `${component} ${msg}${extra}`.trimStart();
}

function formatJson(
  level: LogLevel,
  msg: string,
  context: Record<string, unknown>,
  meta?: Record<string, unknown>,
): string {
  return JSON.stringify({
    level,
    ts: new Date().toISOString(),
    msg,
    ...context,
    ...meta,
  });
}

export function createLogger(config: {
  level: LogLevel;
  format: LogFormat;
}): Logger {
  return createChildLogger(config, {});
}

function createChildLogger(
  config: { level: LogLevel; format: LogFormat },
  context: Record<string, unknown>,
): Logger {
  const minPriority = LEVEL_PRIORITY[config.level];
  const format = config.format === 'json' ? formatJson : formatText;

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;
    const line = format(level, msg, context, meta);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    child: (childContext) =>
      createChildLogger(config, { ...context, ...childContext }),
  };
}
