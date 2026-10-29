// Parent-frame DOM is the only place that knows whether a cross-origin iframe
// was hidden by a site's player tabs. No cross-origin DOM access is attempted.
export function childFrameLayout(document) {
  return [...document.querySelectorAll('iframe,frame')].map(frame => {
    let url = frame.hasAttribute('srcdoc') ? 'about:srcdoc' : frame.getAttribute('src') || 'about:blank';
    try { url = new URL(url, document.baseURI).href; } catch {}
    const rect = frame.getBoundingClientRect();
    const style = document.defaultView.getComputedStyle(frame);
    return { url, visible: rect.width > 1 && rect.height > 1 && !['hidden', 'collapse'].includes(style.visibility) && style.display !== 'none' };
  });
}
