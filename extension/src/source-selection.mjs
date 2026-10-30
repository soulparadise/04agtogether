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
function lordfilmControls(document) {
  if (!['sg.lordfilm5.pro', 'mg.lordfilm.md'].includes(document.location?.hostname)) return null;
  const boxes = [...document.querySelectorAll('.fplayer.tabs-box')].map(box => {
    const tabs = [...box.querySelectorAll('.tabs-sel > span')];
    const full = tabs.filter(tab => normalized(tab.textContent) === 'Full HD');
    const second = tabs.filter(tab => normalized(tab.textContent) === 'Плеер 2' && (tab.getAttribute('onclick') || '').includes('#player-2') && (tab.getAttribute('onclick') || '').includes('https://cdn.lordfilm64.com/'));
    const third = tabs.filter(tab => normalized(tab.textContent) === 'Плеер 3' && (tab.getAttribute('onclick') || '').includes('#player-3') && (tab.getAttribute('onclick') || '').includes('https://vid1787405338.sevstar933krop.com/'));
    return full.length === 1 && second.length === 1 && box.querySelector('#player-2') && box.querySelector('.tabs-b > iframe:not([src])') ? { full: full[0], second: second[0], third: third.length === 1 ? third[0] : null } : null;
  }).filter(Boolean);
  return boxes.length === 1 ? boxes[0] : null;
}
function customVoices(document, player) {
  if (player.id === 'allplay') {
    const items = [...document.querySelectorAll('button.select__drop-item[data-id]')].filter(n => /^t\d+\|[a-zA-Z0-9-]+$/.test(n.getAttribute('data-id') || ''));
    const roots = new Set(items.map(n => n.closest('.select')));
    if (roots.size !== 1 || roots.has(null)) return null;
    return {
      items, head: [...roots][0].querySelector('button.select__item'),
      selectedLabel: () => { const text = [...roots][0].querySelector('.select__item-text'); return text ? normalized([...(text.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ')) : undefined; },
      active: node => node.classList.contains('active'),
      option: node => ({ id: `allplay:${node.getAttribute('data-id').replace('|', ':')}`, label: normalized([...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ')) })
    };
  }
  if (player.id === 'venom') {
    const roots = [...document.querySelectorAll('.dropdown_2c1.hideOnMini_wxn')];
    if (roots.length !== 1) return null;
    return { items: [...roots[0].querySelectorAll('.menu_2sa > .item_2mH')], head: roots[0].querySelector('.head_1gl'), selectedLabel: () => normalized(roots[0].querySelector('.headText_3i3')?.textContent), active: node => node.classList.contains('active_1Rh'), option: node => voiceOption(node.textContent) };
  }
  return null;
}
export function readSelection(document) {
  // Only signals actually observed in the two supported player families.
  const player = document.querySelector('video.allplay__video') ? { id: 'allplay', label: 'Плеер 2 · Allplay' }
    : document.querySelector('video') && [...document.querySelectorAll('script[src]')].some(script => /\/player-venom@[^/]+\/dist\/player\.js/.test(script.src)) ? { id: 'venom', label: 'Full HD · player-venom' } : null;
  if (!player) {
    const controls = lordfilmControls(document);
    if (controls?.full.classList.contains('current')) return { player: { id: 'venom', label: 'Full HD · player-venom' }, voice: null };
    if (controls?.second.classList.contains('current')) return { player: { id: 'allplay', label: 'Плеер 2 · Allplay' }, voice: null };
    if (controls?.third?.classList.contains('current')) return { player: { id: 'playerjs', label: 'Плеер 3 · Playerjs' }, voice: null };
    if (document.location?.hostname === 'vid1787405338.sevstar933krop.com' && document.querySelector('[id^="oframeplayer-"].pjscssed video')) return { player: { id: 'playerjs', label: 'Плеер 3 · Playerjs' }, voice: null };
    return null;
  }
  const custom = customVoices(document, player), label = custom?.selectedLabel?.();
  // The visible header is the selected value; a menu can retain stale active classes.
  const current = custom?.items.filter(label ? node => normalized(custom.option(node)?.label).toLowerCase() === label.toLowerCase() : custom.active);
  if (label !== undefined && (!label || current?.length !== 1)) return { player, voice: null };
  if (current?.length === 1) return { player, voice: custom.option(current[0]) };
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
  const custom = customVoices(document, actual.player);
  if (custom) {
    const items = custom.items.filter(node => normalized(custom.option(node).label).toLowerCase() === normalized(desired.voice.label).toLowerCase());
    if (items.length !== 1 || !custom.head) return false;
    custom.head.click(); items[0].click(); return true;
  }
  const control = voiceSelect(document);
  const matches = [...(control?.options || [])].filter(option => normalized(option.textContent).toLowerCase() === normalized(desired.voice.label).toLowerCase());
  if (matches.length !== 1 || matches[0].disabled) return false;
  control.value = matches[0].value;
  control.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  return true;
}
export function applyPlayer(document, desired) {
  const controls = lordfilmControls(document);
  if (controls && ['allplay', 'venom', 'playerjs'].includes(desired?.player?.id)) {
    const tab = desired.player.id === 'allplay' ? controls.second : desired.player.id === 'playerjs' ? controls.third : controls.full;
    if (!tab) return false;
    if (tab.classList.contains('current') || tab.getBoundingClientRect().width <= 1) return false;
    tab.click(); return true;
  }
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
