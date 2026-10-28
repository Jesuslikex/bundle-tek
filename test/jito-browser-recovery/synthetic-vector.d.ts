declare module '@jito-synthetic-vector' {
  const vector: {
    manifest: import('../../lib/jito-bundle').JitoBundleManifest;
    signed: string;
    signature: string;
  };
  export default vector;
}
