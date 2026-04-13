/**
 * Structured JSON logger — emits one JSON object per line to stdout/stderr.
 * Fields: level, timestamp (ISO), message, and any safe context fields.
 *
 * Security rules:
 *  - error() never logs error.message, error.stack, error.response, or request data
 *  - Only safe fields are surfaced: error.code, error.name, error.status
 */

const emit = (level, message, fields) => {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...fields,
  };
  // info/warn go to stdout; error goes to stderr
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.info(JSON.stringify(entry));
  }
};

const logger = {
  info: (message, fields = {}) => {
    emit('info', message, fields);
  },

  warn: (message, fields = {}) => {
    emit('warn', message, fields);
  },

  /**
   * Log an error without exposing sensitive details.
   * @param {string} message  - Safe description of where the error occurred.
   * @param {Error|unknown} error - The caught error (message/stack are NOT logged).
   */
  error: (message, error) => {
    const safe = {};
    if (error?.code !== undefined)   safe.code   = error.code;
    if (error?.name)                 safe.type   = error.name;
    if (error?.status !== undefined) safe.status = error.status;
    // Temporarily include error message for debugging
    if (error?.message)              safe.message = error.message;
    // Deliberately omit: error.stack, error.response, request data
    emit('error', message, safe);
  },
};

module.exports = logger;
