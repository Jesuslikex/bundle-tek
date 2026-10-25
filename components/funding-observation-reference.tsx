'use client';

import { useEffect, useRef, useState } from 'react';
import bs58 from 'bs58';
import styles from './funding-observation-reference.module.css';

export type FundingObservationReferenceProps = {
  address: string;
  revision: number;
  source: 'saved' | 'provider';
  funding: {
    signature: string;
    slot: number;
    blockTime: number;
    funders?: string[];
  };
};

function canonical(value: unknown, bytes: number) {
  if (typeof value !== 'string' || value.length > 90) return false;
  const decoded = bs58.decode(value);
  return decoded.length === bytes && bs58.encode(decoded) === value;
}

function admission(props: FundingObservationReferenceProps) {
  try {
    const { address, revision, source, funding } = props;
    if (
      !canonical(address, 32) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > 1e9 ||
      !['saved', 'provider'].includes(source) ||
      !canonical(funding.signature, 64) ||
      !Number.isSafeInteger(funding.slot) ||
      funding.slot < 0 ||
      !Number.isSafeInteger(funding.blockTime) ||
      funding.blockTime < 0 ||
      !Number.isFinite(new Date(funding.blockTime * 1000).getTime()) ||
      (funding.funders !== undefined &&
        (!Array.isArray(funding.funders) ||
          funding.funders.length < 1 ||
          funding.funders.length > 32 ||
          Array.from(funding.funders).some(
            (funder) => !canonical(funder, 32),
          ) ||
          new Set(funding.funders).size !== funding.funders.length))
    )
      return null;
    const timestamp = new Date(funding.blockTime * 1000).toISOString();
    const label =
      source === 'saved'
        ? 'Most recently saved finalized native SOL transfer'
        : 'Oldest provider-reported transaction';
    const reference = [
      'Network: Solana mainnet',
      `Recipient: ${address}`,
      `Wallet revision: ${revision}`,
      `Evidence source: ${source} (${label})`,
      `Signature: ${funding.signature}`,
      `Slot: ${funding.slot}`,
      `Funding block time: ${timestamp}`,
      `Funding block timestamp (seconds): ${funding.blockTime}`,
      `Reported funding sources: ${funding.funders?.join(', ') ?? 'not included in this observation'}`,
      'Already-loaded observation only; not a fresh transaction verification, complete history or proof of ownership.',
    ].join('\n');
    return { reference, signature: funding.signature };
  } catch {
    return null;
  }
}

export function FundingObservationReference(
  props: FundingObservationReferenceProps,
) {
  const value = admission(props);
  return value ? (
    <Reference key={value.reference} {...value} />
  ) : (
    <p>Funding evidence reference is unavailable.</p>
  );
}

function Reference({
  reference,
  signature,
}: {
  reference: string;
  signature: string;
}) {
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  async function copy() {
    const current = ++generation.current;
    setNotice('');
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(reference);
      if (current === generation.current)
        setNotice('Funding reference copied.');
    } catch {
      if (current === generation.current)
        setNotice(
          'Copy unavailable. Select the full reference shown here and copy it manually.',
        );
    }
  }
  return (
    <details className={styles.reference}>
      <summary>Funding evidence reference</summary>
      <pre>{reference}</pre>
      <button type="button" onClick={() => void copy()}>
        Copy funding reference
      </button>
      <output>{notice}</output>
      <p>
        Opening the explorer leaves Bundle. The link does not verify the
        transaction or refresh this observation. Earlier or external funding may
        be missing.
      </p>
      <a
        href={`https://solscan.io/tx/${encodeURIComponent(signature)}`}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        Open transaction on Solscan (mainnet)
      </a>
    </details>
  );
}
