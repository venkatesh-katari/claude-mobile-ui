// `default` sends no effort flag, so the CLI's own configured effort applies.
export const DEFAULT_EFFORT = 'default';

/** Default plus the efforts the given model supports, lowest first. */
export function effortStops(descriptor, modelValue) {
  const model = descriptor.models?.find(item => item.value === modelValue);
  const supported = new Set(model?.efforts || []);
  return (descriptor.effortLevels || []).filter(level => level.value === DEFAULT_EFFORT || supported.has(level.value));
}

/**
 * Keeps an effort valid after a model switch: an unsupported effort drops to
 * the highest supported one below it (e.g. Max -> X-High on GPT-5.5).
 */
export function clampEffort(descriptor, modelValue, effort) {
  if (!effort || effort === DEFAULT_EFFORT) return DEFAULT_EFFORT;
  const stops = effortStops(descriptor, modelValue).filter(level => level.value !== DEFAULT_EFFORT);
  if (stops.some(level => level.value === effort)) return effort;
  const order = (descriptor.effortLevels || []).map(level => level.value);
  const rank = order.indexOf(effort);
  if (rank < 0 || stops.length === 0) return DEFAULT_EFFORT;
  const below = stops.filter(level => order.indexOf(level.value) <= rank);
  return (below.at(-1) || stops[0]).value;
}
