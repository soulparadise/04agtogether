import React, { useEffect, useId, useState } from 'react';
import { extensionRequest } from '../extension-bridge.mjs';
import { browsers, copyBrowserAddress, detectBrowser } from '../extension-browsers.mjs';

export default function ExtensionInstall({ installed = false, onDetected, compact = false }) {
  const [browser, setBrowser] = useState('');
  const [mobile, setMobile] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const [detected, setDetected] = useState(false);
  const id = useId();
  const available = installed || detected;
  const selected = browsers.find(item => item.id === browser);
  useEffect(() => {
    let active = true;
    void detectBrowser().then(result => { if (active) { setBrowser(result.id); setMobile(result.mobile); } });
    void fetch('/downloads/extension.json', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(value => {
      if (active && /^\d+(\.\d+){1,3}$/.test(value.version) && value.url === '/downloads/04agtogether-extension.zip') setMetadata(value);
    }).catch(() => { if (active) setMessage('Архив пока недоступен. Попробуй обновить страницу позже.'); });
    const check = () => { void extensionRequest({ type: 'ping' }, 1500).then(reply => { if (active && reply.ok === true) { setDetected(true); onDetected?.(true); } }).catch(() => {}); };
    check(); window.addEventListener('focus', check);
    return () => { active = false; window.removeEventListener('focus', check); };
  }, [onDetected]);
  async function check() {
    setChecking(true);
    try {
      const reply = await extensionRequest({ type: 'ping' }, 2000);
      if (reply.ok !== true) throw new Error();
      setDetected(true); onDetected?.(true); setMessage('Расширение обнаружено. Можно открыть фильм.');
    } catch { setDetected(false); setMessage('Расширение не ответило. После установки обнови страницу комнаты.'); }
    finally { setChecking(false); }
  }
  const instructions = <>
    {mobile && <p className="hint">Расширение предназначено для настольного браузера. Открой эту ссылку на компьютере; установка на телефоне не подтверждена.</p>}
    <div className="extension-download">{metadata ? <a className="primary" href={metadata.url} download={metadata.filename}>Скачать расширение</a> : <span>Скачивание пока недоступно</span>}<span>{metadata ? `Версия ${metadata.version}` : 'Получаем версию…'}</span></div>
    <details><summary>Как установить — 5 шагов</summary>
      <ol><li>Скачай ZIP кнопкой выше.</li><li>Распакуй архив в отдельную папку. Не удаляй её после установки: браузер использует эту папку для работы расширения.</li>
        <li><label htmlFor={id}>Твой браузер</label><select id={id} value={browser} onChange={event => { setBrowser(event.target.value); setMessage(''); }}><option value="">Выбери браузер вручную</option>{browsers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          {!selected && <p>Для этого браузера поддержка расширения пока не подтверждена. Рекомендуем Google Chrome.</p>}
          {selected && <><div className="extension-address"><code>{selected.address}</code><button className="quiet" onClick={() => { void copyBrowserAddress(selected.address).then(() => setMessage('Адрес скопирован. Нажми Ctrl+L, затем Ctrl+V и Enter.')).catch(() => setMessage(`Не удалось скопировать автоматически. Скопируй адрес вручную: ${selected.address}`)); }}>Скопировать адрес</button></div><p>Вставь адрес в адресную строку браузера.</p></>}
        </li>
        <li>{browser === 'yandex' ? <p>Совместимость с Яндекс Браузером пока не подтверждена. Его <a href="https://yandex.ru/support/browser/ru/personalization/extension" target="_blank" rel="noreferrer">официальная инструкция</a> описывает установку CRX3 через browser://tune. Этот сайт распространяет ZIP без ключей подписи. Для установки этой версии используй Google Chrome.</p> : <><p>В настольном Google Chrome включи «Режим разработчика», нажми «Загрузить распакованное расширение» и выбери распакованную папку 04agtogether. В ней должен находиться manifest.json.</p>{selected && browser !== 'chrome' && <p>В выбранном браузере названия кнопок могут отличаться. Работа 04agtogether в нём пока не проверена.</p>}</>}</li>
        <li>Вернись в эту комнату, нажми «Проверить расширение», затем «Открыть фильм». Если расширение не обнаружилось, обнови страницу — вводить комнату заново не нужно.</li>
      </ol>
    </details>
    <details><summary>Как обновить расширение</summary><p>Автоматического обновления пока нет. В Google Chrome:</p><ol><li>Скачай новый ZIP.</li><li>Закрой просмотр и распакуй содержимое в ту же папку установленного расширения, согласившись заменить файлы. Сохрани папку и не удаляй расширение.</li><li>Открой страницу расширений, включи «Режим разработчика» и нажми «Перезагрузить» на карточке 04agtogether (либо доступную кнопку «Обновить»).</li><li>Обнови вкладки комнаты и фильма. Если браузер попросит доступ — разреши его повторно.</li></ol><p>В других браузерах способ обновления может отличаться. ID расширения сохранён; удаление и повторная установка не требуются.</p></details>
    <button className="quiet" disabled={checking} onClick={() => void check()}>{checking ? 'Проверяем…' : 'Проверить расширение'}</button>
    {message && <p className="hint" role="status">{message}</p>}
  </>;
  return <section id="extension-install" className="extension-install" aria-label="Установка расширения 04agtogether">
    {available || compact ? <details><summary>{available ? 'Расширение обнаружено · установка и обновление' : 'Установить расширение 04agtogether'}</summary>{instructions}</details> : <><h3>Для совместного просмотра установи расширение 04agtogether</h3>{instructions}</>}
  </section>;
}
