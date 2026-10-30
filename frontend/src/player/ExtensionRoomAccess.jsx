import React from 'react';
import ExtensionInstall from './ExtensionInstall.jsx';
export default function ExtensionRoomAccess({ source, installed, busy, onOpen, onDetected, status }) {
  return <div className="video-empty extension-access"><h2>Смотрим вместе</h2><p className="film-address">{source.url}</p>
    <p>Плеер: {source.selection?.player.label || 'определяется расширением'} · Озвучка: {source.selection?.voice?.label || 'не определена'}</p>
    <p role="status">{status || 'Открой фильм, чтобы проверить выбранный источник.'}</p>
    {source.selection && <p className="hint">Расширение сопоставляет выбранный источник. Если переключение недоступно, выбери указанные плеер и озвучку на странице фильма и подтверди выбор в расширении.</p>}
    <button className="primary" onClick={onOpen} disabled={!installed || busy}>{busy ? 'Открываем…' : 'Открыть фильм'}</button>
    {installed && <p>Расширение само подключит плеер к этой комнате. При первом посещении разрешите доступ к сайту в Chrome.</p>}
    <ExtensionInstall installed={installed} onDetected={onDetected} />
  </div>;
}
