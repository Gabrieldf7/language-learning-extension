/**
 * LangLearn — Centralised Logger
 *
 * All console output is prefixed with [LangLearn] and tagged with the log
 * level so it can be filtered easily in DevTools.
 *
 * Usage:
 *   import { log } from '../utils/logger.js';
 *   log.info('Popup opened');
 *   log.error('Something broke', errorObj);
 */

const PREFIX = '[LangLearn]';

/**
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param  {...any} args
 */
function emit(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const tag = `${PREFIX} [${level}] ${timestamp}`;

  switch (level) {
    case 'DEBUG':
      console.debug(tag, message, ...args);
      break;
    case 'INFO':
      console.info(tag, message, ...args);
      break;
    case 'WARN':
      console.warn(tag, message, ...args);
      break;
    case 'ERROR':
      console.error(tag, message, ...args);
      break;
    default:
      console.log(tag, message, ...args);
  }
}

export const log = {
  debug: (message, ...args) => emit('DEBUG', message, ...args),
  info:  (message, ...args) => emit('INFO',  message, ...args),
  warn:  (message, ...args) => emit('WARN',  message, ...args),
  error: (message, ...args) => emit('ERROR', message, ...args),
};
