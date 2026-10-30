const normalized = text => String(text || '').normalize('NFC').trim().replace(/\s+/g, ' ');
export function voiceOption(label) {
  label = normalized(label).slice(0, 96);
  if (!label) return null;
  let hash = 2166136261; for (const char of label.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return { id: `label:${(hash >>> 0).toString(16)}`, label };
}
function voiceSelect(document) {
  return [...document.querySelectorAll('select')].find(select => /озвуч|перевод|voice|audio|translation/i.test([
    select.getAttribute('aria-label'), ...[...(select.labels || [])].map(label => label.textContent)
  ].join(' ')));
}
export function readSelection(document) {
  // Only signals actually observed in the two supported player families.
  const player = document.querySelector('video.allplay__video') ? { id: 'allplay', label: 'Плеер 2 · Allplay' }
    : document.querySelector('video') && [...document.querySelectorAll('script[src]')].some(script => /\/player-venom@[^/]+\/dist\/player\.js/.test(script.src)) ? { id: 'venom', label: 'Full HD · player-venom' } : null;
  if (!player) return null;
  const control = voiceSelect(document);
  const option = control?.selectedOptions?.[0];
  return { player, voice: option && !option.disabled && option.value ? voiceOption(option.textContent) : null };
}
export function matchesSelection(actual, desired) {
  return Boolean(actual && desired && actual.player.id === desired.player.id && (!desired.voice || (actual.voice && normalized(actual.voice.label).toLowerCase() === normalized(desired.voice.label).toLowerCase())));
}
export function selectionHint(actual, desired) {
  if (!desired) return '';
  if (actual?.player?.id !== desired.player.id) return `Выбран другой плеер. Владелец использует ${desired.player.label}. Выбери его на странице фильма.`;
  return `Выбрана другая озвучка. Владелец использует «${desired.voice?.label || 'не определена'}». Выбери её и подтверди ручной выбор в расширении.`;
}
export function applyVoice(document, desired) {
  const actual = readSelection(document);
  if (!actual || actual.player.id !== desired.player.id || !desired.voice || matchesSelection(actual, desired)) return false;
  const control = voiceSelect(document);
  const matches = [...(control?.options || [])].filter(option => normalized(option.textContent).toLowerCase() === normalized(desired.voice.label).toLowerCase());
  if (matches.length !== 1 || matches[0].disabled) return false;
  control.value = matches[0].value;
  control.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  return true;
}
export function applyPlayer(document, desired) {
  // No guesses by tab index or clicks on arbitrary advertising links.
  if (desired?.player?.id !== 'allplay') return false;
  const tabs = [...document.querySelectorAll('[role="tab"][aria-controls]')].filter(tab => {
    if (normalized(tab.textContent).toLowerCase() !== 'плеер 2' || tab.getBoundingClientRect().width <= 1) return false;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    return [...(panel?.querySelectorAll('iframe[src]') || [])].some(frame => { try { return new URL(frame.src).origin === 'https://cdn.lordfilm64.com'; } catch { return false; } });
  });
  if (tabs.length !== 1 || tabs[0].getAttribute('aria-selected') === 'true') return false;
  tabs[0].click(); return true;
}
