// Names from Agave's jsonParsed Token-2022 extension representation.
export function tokenExtensionNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error('Token extension details unavailable.');
  const names = value.map((item) => {
    const name = item?.extension;
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(name))
      throw new Error('Invalid token extension.');
    return name;
  });
  if (new Set(names).size !== names.length)
    throw new Error('Duplicate token extension.');
  return names;
}
