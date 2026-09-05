export class DraftRevision {
 private revision = 0;
 private saving = false;
 beginSave() { if (this.saving) return false; this.saving = true; return true; }
 finishSave() { this.saving = false; }
 capture() { return this.revision; }
 edit() { this.revision += 1; }
 isCurrent(revision: number) { return this.revision === revision; }
}
