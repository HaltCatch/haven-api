import { defaultLimits } from '@haven/schema';
import type { ValidationLimits } from '@haven/schema';

/** Transport has finite room for candidate metadata; document validation keeps its own limits. */
export const httpRequestMaxBytes = defaultLimits.maxBytes + 4 * 1024;
export const candidateEnvelopeLimits: Readonly<ValidationLimits> = Object.freeze({
  ...defaultLimits,
  maxBytes: httpRequestMaxBytes,
  maxDepth: defaultLimits.maxDepth + 1,
  // The JSON guard uses maxNodes * 100 physical values. Metadata needs nine extra values.
  maxNodes: defaultLimits.maxNodes + 1,
});
