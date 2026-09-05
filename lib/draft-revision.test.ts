import { expect, it } from 'vitest';
import { DraftRevision } from './draft-revision';
it('rejects stale loads and saves after edits or a new plan', () => {
 const revision = new DraftRevision();
 const loading = revision.capture();
 revision.edit();
 expect(revision.isCurrent(loading)).toBe(false);
 const saving = revision.capture();
 revision.edit();
 expect(revision.isCurrent(saving)).toBe(false);
 expect(revision.isCurrent(revision.capture())).toBe(true);
});

it('keeps saves serialized even when editing or resetting a draft', () => {
 const revision = new DraftRevision();
 expect(revision.beginSave()).toBe(true);
 revision.edit();
 expect(revision.beginSave()).toBe(false);
 revision.finishSave();
 expect(revision.beginSave()).toBe(true);
});
