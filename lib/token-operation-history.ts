export const operationCategories = [
  'All',
  'Project',
  'Preparation',
  'Buy',
  'Sell',
  'Session',
  'Bundle',
  'Jobs',
  'Conditional',
  'Warmup',
  'Withdrawals',
] as const;
export type OperationCategory = (typeof operationCategories)[number];
export const historySources = [
  'project',
  'preparation',
  'signing',
  'session',
  'bundle',
  'job',
  'conditional',
  'warmup',
  'withdrawal',
] as const;
export type HistorySource = (typeof historySources)[number];
export type TokenOperation = {
  key: string;
  projectId: string;
  source: HistorySource;
  category: OperationCategory;
  createdAt: string;
  label: string;
  state: string;
  details: string[];
  signature: string | null;
  sessionEventId?: string;
};
export type OperationPage = {
  projectId: string;
  category: OperationCategory;
  executionAllowed: false;
  records: TokenOperation[];
  missingSources: HistorySource[];
  nextCursor: string | null;
};
export type OperationRow = {
  id: string;
  source: HistorySource;
  category: OperationCategory;
  ordinal: number;
  createdAt: string;
  payload: string;
};
export function operationCategory(value: string | null): OperationCategory {
  if (value === null) return 'All';
  if (!operationCategories.includes(value as OperationCategory))
    throw new Error('Invalid history category.');
  return value as OperationCategory;
}
export function historyCursor(
  projectId: string,
  category: OperationCategory,
  key: string,
) {
  return JSON.stringify({ projectId, category, key });
}
export function decodeHistoryCursor(
  raw: string | null,
  projectId: string,
  category: OperationCategory,
) {
  if (raw === null) return null;
  if (raw.length > 240) throw new Error('Invalid history cursor.');
  const value = JSON.parse(raw) as {
    projectId: string;
    category: OperationCategory;
    key: string;
  };
  if (
    !value ||
    value.projectId !== projectId ||
    value.category !== category ||
    typeof value.key !== 'string' ||
    !/^(project|preparation|signing|session|bundle|job|conditional|warmup|withdrawal):[a-f0-9-]{32,36}$/.test(
      value.key,
    ) ||
    historyCursor(projectId, category, value.key) !== raw
  )
    throw new Error('History cursor context differs.');
  return value.key;
}
export function decodeOperationPage(
  value: unknown,
  projectId: string,
  category: OperationCategory,
): OperationPage {
  const p = value as OperationPage;
  if (
    !p ||
    p.projectId !== projectId ||
    p.category !== category ||
    p.executionAllowed !== false ||
    !Array.isArray(p.records) ||
    p.records.length > 50 ||
    !Array.isArray(p.missingSources) ||
    p.missingSources.some((s) => !historySources.includes(s)) ||
    new Set(p.missingSources).size !== p.missingSources.length ||
    (p.nextCursor !== null && typeof p.nextCursor !== 'string')
  )
    throw new Error('Operation history unavailable.');
  for (const r of p.records)
    if (
      !r ||
      r.projectId !== projectId ||
      !historySources.includes(r.source) ||
      !r.key.startsWith(r.source + ':') ||
      !operationCategories.includes(r.category) ||
      (category !== 'All' && r.category !== category) ||
      !Number.isFinite(Date.parse(r.createdAt)) ||
      typeof r.label !== 'string' ||
      !r.label ||
      typeof r.state !== 'string' ||
      !Array.isArray(r.details) ||
      r.details.some((d) => typeof d !== 'string') ||
      (r.signature !== null && typeof r.signature !== 'string') ||
      (r.sessionEventId !== undefined &&
        (r.source !== 'session' ||
          r.category !== 'Session' ||
          typeof r.sessionEventId !== 'string' ||
          !/^[a-f0-9]{32}$/.test(r.sessionEventId) ||
          r.key !== `session:${r.sessionEventId}`))
    )
      throw new Error('Operation record differs.');
  if (
    new Set(p.records.map((r) => r.key)).size !== p.records.length ||
    (p.nextCursor !== null &&
      decodeHistoryCursor(p.nextCursor, projectId, category) !==
        p.records.at(-1)?.key)
  )
    throw new Error('Operation pagination differs.');
  return p;
}
