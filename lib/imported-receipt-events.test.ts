import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { ImportedSwapReceipt } from './imported-approval-history';
import {
  notifyImportedReceiptSaved,
  subscribeImportedReceiptSaved,
  IMPORTED_RECEIPT_SAVED,
} from './imported-receipt-events';
import { supplyWallet } from '../test/supply-history-fixture';
const receipt = {
  id: 'r',
  projectId: 'p',
  projectRevision: 1,
  document: {
    mint: supplyWallet(9),
    wallet: supplyWallet(1),
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    side: 'Buy',
    tokenUnitsRaw: '1',
    signatureVerified: true,
    commitment: 'finalized',
    network: 'mainnet',
  },
} as ImportedSwapReceipt;
afterEach(() => vi.unstubAllGlobals());
it('deduplicates same-page and cross-tab notices, validates the channel envelope and closes subscriptions', () => {
  class Channel {
    static instances: Channel[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    constructor(readonly name: string) {
      Channel.instances.push(this);
    }
    postMessage(data: unknown) {
      for (const c of Channel.instances)
        if (c !== this && !c.closed && c.name === this.name)
          c.onmessage?.({ data });
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { BroadcastChannel: Channel }),
  );
  const receive = vi.fn(),
    stop = subscribeImportedReceiptSaved(
      { projectId: 'p', mint: receipt.document.mint },
      receive,
    );
  notifyImportedReceiptSaved(receipt);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(Channel.instances.filter((c) => !c.closed)).toHaveLength(1);
  const sender = new Channel(Channel.instances[0].name);
  const notice = {
    id: 'other',
    projectId: 'p',
    mint: receipt.document.mint,
    wallet: receipt.document.wallet,
    signature: receipt.document.signature,
    side: 'Buy',
  };
  sender.postMessage({ format: 'bundle-receipt-notice-v1', notice });
  expect(receive).toHaveBeenCalledTimes(2);
  sender.postMessage({ format: 'bundle-receipt-notice-v1', notice });
  for (const patch of [
    { projectId: 'foreign' },
    { mint: supplyWallet(8) },
    { wallet: 'bad' },
    { signature: 'bad' },
    { extra: 'unexpected' },
    { id: 'x'.repeat(65) },
  ])
    sender.postMessage({
      format: 'bundle-receipt-notice-v1',
      notice: { ...notice, id: 'bad', ...patch },
    });
  sender.postMessage({
    format: 'unknown',
    notice: { ...notice, id: 'wrong-format' },
  });
  expect(receive).toHaveBeenCalledTimes(2);
  stop();
  sender.postMessage({
    format: 'bundle-receipt-notice-v1',
    notice: { ...notice, id: 'after-stop' },
  });
  expect(receive).toHaveBeenCalledTimes(2);
  sender.close();
  expect(Channel.instances.every((c) => c.closed)).toBe(true);
});
it('preserves local invalidation when browser channels are unavailable or blocked', () => {
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      BroadcastChannel: class {
        constructor() {
          throw new Error('Blocked');
        }
      },
    }),
  );
  const receive = vi.fn(),
    stop = subscribeImportedReceiptSaved(
      { projectId: 'p', mint: receipt.document.mint },
      receive,
    );
  notifyImportedReceiptSaved(receipt);
  expect(receive).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new CustomEvent(IMPORTED_RECEIPT_SAVED, { detail: { id: 'malformed' } }),
  );
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
});
it('notifies only matching project/mint/wallet consumers once and removes listeners cleanly', () => {
  vi.stubGlobal('window', new EventTarget());
  const matching = vi.fn(),
    foreign = vi.fn();
  const stop = subscribeImportedReceiptSaved(
    {
      projectId: 'p',
      mint: receipt.document.mint,
      wallet: receipt.document.wallet,
    },
    matching,
  );
  const stopForeign = subscribeImportedReceiptSaved(
    { projectId: 'p', mint: receipt.document.mint, wallet: supplyWallet(2) },
    foreign,
  );
  notifyImportedReceiptSaved(receipt);
  notifyImportedReceiptSaved(receipt);
  expect(matching).toHaveBeenCalledTimes(1);
  expect(foreign).not.toHaveBeenCalled();
  stop();
  stopForeign();
  notifyImportedReceiptSaved({ ...receipt, id: 'new' });
  expect(matching).toHaveBeenCalledTimes(1);
});
it('ignores unfinalized receipts and other project or mint scopes', () => {
  vi.stubGlobal('window', new EventTarget());
  const listener = vi.fn();
  const stop = subscribeImportedReceiptSaved(
    { projectId: 'p', mint: receipt.document.mint },
    listener,
  );
  notifyImportedReceiptSaved({
    ...receipt,
    document: { ...receipt.document, commitment: 'confirmed' },
  });
  notifyImportedReceiptSaved({ ...receipt, projectId: 'foreign' });
  notifyImportedReceiptSaved({
    ...receipt,
    document: { ...receipt.document, mint: supplyWallet(8) },
  });
  expect(listener).not.toHaveBeenCalled();
  stop();
});
