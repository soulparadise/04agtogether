// Imported by the app, but production's import.meta.env.DEV branch is removed.
export function developmentSocketOptions(search = location.search, cryptoSource = globalThis.crypto) {
  const params = new URLSearchParams(search);
  const profile = params.get('network');
  if (!['100', '300', '500', 'jitter'].includes(profile)) return {};
  // randomUUID is unavailable on plain HTTP LAN origins; getRandomValues works
  // there too. This identifier selects a test profile, it grants no access.
  return { query: { testNetwork: profile, testClient: [...cryptoSource.getRandomValues(new Uint32Array(2))].join('-') } };
}

export function developmentSearch(search = location.search) {
  const params = new URLSearchParams(search);
  const result = new URLSearchParams();
  for (const key of ['diagnostics', 'network', 'mediaStall']) if (params.has(key)) result.set(key, params.get(key));
  return result.size ? `?${result}` : '';
}
