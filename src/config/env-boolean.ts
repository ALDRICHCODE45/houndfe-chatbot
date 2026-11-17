/**
 * Reads a boolean env flag the same way `Joi.boolean()` (non-strict, the
 * validation used in env.validation.ts) interprets it: case-insensitive
 * `true`/`false`, surrounding whitespace ignored. Anything else (unset,
 * empty, `1`, `yes`, ...) is rejected at boot by Joi and falls back to the
 * default here, so validation and runtime never disagree.
 */
export const envBoolean = (
  value: string | undefined,
  fallback = false,
): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
};
