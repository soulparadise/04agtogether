import { webOrigin, permissionPattern, samePage } from './security.mjs';

function framePermissionOrigin(frame, frames) {
  const visited = new Set();
  while (frame && !visited.has(frame.frameId)) {
    visited.add(frame.frameId);
    try { return webOrigin(frame.url); } catch {}
    // Lordfilm creates a src-less frame. Resolve only these inherited schemes,
    // not arbitrary data/blob URLs. This is a permission *candidate*; Chrome
    // still enforces the actual frame origin and sandbox when injecting.
    if (!['about:blank', 'about:srcdoc'].includes(frame.url)) return null;
    frame = frames.get(frame.parentFrameId);
  }
  return null;
}

export async function discoverPlayer(chrome, tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  const depth = frame => { let n = 0; const seen = new Set(); while (frame && !seen.has(frame.frameId)) { seen.add(frame.frameId); frame = byId.get(frame.parentFrameId); if (frame) n++; } return n; };
  frames.sort((a, b) => depth(a) - depth(b));
  const inspected = new Map(), visible = new Map();
  const candidates = [], neededOrigins = new Set();
  for (const frame of frames) {
    const parent = byId.get(frame.parentFrameId);
    const layout = inspected.get(frame.parentFrameId)?.childFrames;
    const matches = layout?.filter(child => samePage(child.url, frame.url)
      || (['about:blank', 'about:srcdoc'].includes(child.url) && parent && samePage(frame.url, parent.url)));
    const shown = visible.get(frame.parentFrameId) !== false && (frame.frameId === 0 || !layout || (matches.length > 0 && matches.every(child => child.visible)));
    visible.set(frame.frameId, shown);
    if (!shown) continue;
    const origin = framePermissionOrigin(frame, byId);
    if (!origin) continue;
    if (!await chrome.permissions.contains({ origins: [permissionPattern(origin)] })) { neededOrigins.add(origin); continue; }
    try {
      let result;
      try { result = await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'discover' }, { frameId: frame.frameId }); }
      catch {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ['content.js'], world: 'ISOLATED' });
        result = await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'discover' }, { frameId: frame.frameId });
      }
      inspected.set(frame.frameId, result);
      candidates.push({ frameId: frame.frameId, ...result });
    } catch { /* Restricted/sandboxed frames stay inaccessible. */ }
  }
  // Confirm the parent tab again after asynchronous frame inspection. A result
  // from the frame that was hidden/replaced meanwhile is never authoritative.
  const initialTop = inspected.get(0);
  let top = initialTop;
  if (initialTop) {
    try { top = await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'discover' }, { frameId: 0 }); }
    catch { return { frame: null, neededOrigins: [...neededOrigins], changed: true }; }
    if (JSON.stringify(top.selection) !== JSON.stringify(initialTop.selection) || JSON.stringify(top.childFrames) !== JSON.stringify(initialTop.childFrames)) return { frame: null, neededOrigins: [...neededOrigins], changed: true };
  }
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.count || 0) - (a.count || 0));
  const selectedPlayer = top?.selection?.player.id;
  return { frame: candidates.find(item => item.count > 0 && (!selectedPlayer || item.selection?.player.id === selectedPlayer)) || candidates.find(item => item.frameId === 0), neededOrigins: [...neededOrigins] };
}

export async function registerOrigins(chrome, origins) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  for (const origin of origins || []) {
    if (!/^https?:\/\/[^*]+\/\*$/.test(origin)) continue;
    const id = 'site-' + [...new TextEncoder().encode(origin)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const existing = registered.find(script => script.id === id);
    if (!existing) await chrome.scripting.registerContentScripts([{ id, matches: [origin], js: ['content.js'], allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: false }]);
    else if (!existing.matchOriginAsFallback) await chrome.scripting.updateContentScripts([{ id, matchOriginAsFallback: true }]);
  }
}
