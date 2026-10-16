// Qualification must use the same Node major as the production engine.
export const STOCK_QUALIFICATION_NODE_MAJOR = 24;

export function requireStockQualificationRuntime(
  version = process.versions.node,
) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    Number(version.split('.')[0]) !== STOCK_QUALIFICATION_NODE_MAJOR
  )
    throw Error(
      'Stock qualification requires production Node 24.x. No provider reads were started.',
    );
  return {
    nodeVersion: version,
    requiredNodeMajor: STOCK_QUALIFICATION_NODE_MAJOR,
  };
}
