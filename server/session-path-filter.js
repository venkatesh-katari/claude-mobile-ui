// @ts-check

import picomatch from 'picomatch';

/**
 * Accept either a convenient comma-separated list or a JSON string array.
 * JSON is preferable when a glob itself contains a comma.
 *
 * @param {string | undefined} rawValue
 * @returns {string[]}
 */
export function parseSessionIgnoreGlobs(rawValue) {
  const value = rawValue?.trim();
  if (!value) return [];

  let patterns;
  if (value.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new TypeError(`SESSION_IGNORE_GLOBS must be a comma-separated list or JSON string array: ${getErrorMessage(error)}`);
    }
    if (!Array.isArray(parsed) || parsed.some(pattern => typeof pattern !== 'string')) {
      throw new TypeError('SESSION_IGNORE_GLOBS JSON value must be an array of strings');
    }
    patterns = parsed;
  } else {
    patterns = value.split(',');
  }

  return [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
}

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} value */
function normalizeSeparators(value) {
  return value.replaceAll('\\', '/');
}

/**
 * Builds the immutable policy used by every backend-facing discovery route.
 * Negated globs are intentionally disabled: ignore rules compose as a simple
 * OR, which keeps their behavior predictable and avoids an accidental `!foo`
 * rule matching nearly every project.
 *
 * @param {string | undefined} rawValue
 */
export function createSessionPathFilter(rawValue) {
  const patterns = parseSessionIgnoreGlobs(rawValue);
  const matchers = patterns.map(pattern => picomatch(normalizeSeparators(pattern), {
    dot: true,
    nocase: process.platform === 'win32',
    nonegate: true,
  }));

  return Object.freeze({
    patterns: Object.freeze([...patterns]),

    /** @param {unknown} candidate */
    isIgnored(candidate) {
      if (typeof candidate !== 'string' || !candidate) return false;
      const normalized = normalizeSeparators(candidate);
      return matchers.some(matches => matches(normalized));
    },
  });
}
