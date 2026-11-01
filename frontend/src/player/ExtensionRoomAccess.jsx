import React from 'react';
import ExtensionInstall from './ExtensionInstall.jsx';
export default function ExtensionRoomAccess({ source, installed, busy, onOpen, onDetected, status }) {
  return <div className="video-empty extension-access"><h2>Смотрим вместе</h2><p className="film-address">{source.url}</p>
    <p>Play/Pause и позиция общие. Плеер и озвучку каждый выбирает самостоятельно на странице фильма.</p>
    <p role="status">{status || 'Открой фильм, чтобы проверить выбранный источник.'}</p>
    <button className="primary" onClick={onOpen} disabled={!installed || busy}>{busy ? 'Открываем…' : 'Открыть фильм'}</button>
    {installed && <p>Расширение само подключит плеер к этой комнате. При первом посещении разрешите доступ к сайту в Chrome.</p>}
    <ExtensionInstall installed={installed} onDetected={onDetected} />
  </div>;
}
