// Agave jsonParsed representation of mint-side metadata pointer and metadata.
export function decodeToken2022Identity(extensions: unknown, mint: string) {
  if (extensions === undefined) return null;
  if (!Array.isArray(extensions) || extensions.length > 64)
    throw new Error('Invalid Token-2022 extensions.');
  const metadata = extensions.filter(
    (item) => item?.extension === 'tokenMetadata',
  );
  if (!metadata.length) return null;
  const pointers = extensions.filter(
    (item) => item?.extension === 'metadataPointer',
  );
  if (
    metadata.length !== 1 ||
    pointers.length !== 1 ||
    pointers[0]?.state?.metadataAddress !== mint ||
    metadata[0]?.state?.mint !== mint
  )
    throw new Error('Token-2022 metadata linkage is inconsistent.');
  function text(value: unknown, maxBytes: number, required: boolean) {
    if (
      typeof value !== 'string' ||
      new TextEncoder().encode(value).length > maxBytes
    )
      throw new Error('Token-2022 identity text is unavailable or too long.');
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 || (code >= 127 && code <= 159))
        throw new Error('Invalid Token-2022 identity text.');
      // JSON can carry unmatched UTF16 surrogates; reject rather than silently replacing them.
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw new Error('Invalid Token-2022 Unicode.');
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw new Error('Invalid Token-2022 Unicode.');
    }
    const clean = value.trim();
    if (required && !clean)
      throw new Error('Token-2022 name or symbol is unavailable.');
    return clean;
  }
  const state = metadata[0].state;
  return {
    name: text(state.name, 256, true),
    symbol: text(state.symbol, 256, true),
    metadataUri: text(state.uri, 2048, false),
  };
}
