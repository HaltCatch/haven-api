import type { HavenDocument } from '@haven/schema';
import { sample } from './support.js';

export function documentOfBytes(bytes: number, id = 'model'): HavenDocument {
  const document = sample(id);
  document.ui.props = { title: '' };
  document.ui.props['title'] = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(document)));
  return document;
}
export function physicalValues(value: unknown): number {
  const pending = [value];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    count++;
    if (current !== null && typeof current === 'object')
      for (const child of Object.values(current)) pending.push(child);
  }
  return count;
}
