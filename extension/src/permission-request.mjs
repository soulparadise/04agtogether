import { permissionPattern } from './security.mjs';

// Prepare before the click. Awaiting contains() inside a click would risk
// losing the user gesture required for a genuinely new permission request.
export async function missingPermissionPatterns(chrome, urls) {
  const patterns = [...new Set(urls.filter(Boolean).map(permissionPattern))];
  const granted = await Promise.all(patterns.map(pattern => chrome.permissions.contains({ origins: [pattern] })));
  return patterns.filter((_pattern, index) => !granted[index]);
}
export function requestMissingPermissions(chrome, patterns) {
  return patterns.length ? chrome.permissions.request({ origins: patterns }) : Promise.resolve(true);
}
