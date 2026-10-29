// An actual dedicated worker owns the polling connection; it outlives MV3 SW sleep.
const worker = new Worker('socket-worker.js', { type: 'module' });
const pending = new Map(); let next = 0;
let persisted = Promise.resolve();
function call(message) {
  return new Promise(resolve => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: { message: 'Соединение не ответило.' } }); }, 16000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); }); worker.postMessage({ id, message });
  });
}
worker.onmessage = ({ data }) => {
  if ('persist' in data) { persisted = persisted.then(() => chrome.runtime.sendMessage({ target: 'background', type: 'persist', session: data.persist })).catch(() => {}); return; }
  if (data.deliver) { void chrome.runtime.sendMessage({ target: 'background', type: 'deliver', ...data.deliver }).catch(() => {}); return; }
  const reply = pending.get(data.id); pending.delete(data.id); void persisted.then(() => reply?.(data.result));
};
const initialized = chrome.runtime.sendMessage({ target: 'background', type: 'bootstrap' }).then(session => session?.pair ? call({ type: 'pair', ...session }) : null);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'engine' || sender.id !== chrome.runtime.id) return;
  // Credentials/control come only from our popup/SW; sites can only use the narrow content channel.
  const trusted = !sender.tab && [chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('background.js')].includes(sender.url);
  if (message.type === 'content' && sender.tab) {
    void initialized.then(() => call({ type: 'content', sender: { tabId: sender.tab.id, frameId: sender.frameId, pageURL: sender.tab.url }, payload: message.payload })).then(reply);
  } else if (trusted) void initialized.then(() => call(message)).then(reply);
  else { reply({ ok: false }); return; }
  return true;
});
