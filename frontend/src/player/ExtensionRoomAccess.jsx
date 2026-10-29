import React from 'react';
export default function ExtensionRoomAccess({ source, installed, busy, onOpen }) {
  return <div className="video-empty extension-access"><h2>Смотрим вместе</h2><p className="film-address">{source.url}</p>
    <button className="primary" onClick={onOpen} disabled={!installed || busy}>{busy ? 'Открываем…' : 'Открыть фильм'}</button>
    {installed ? <p>Расширение само подключит плеер к этой комнате. При первом посещении разрешите доступ к сайту в Chrome.</p> : <><p>Для совместного просмотра установите расширение 04agtogether в Chrome и обновите эту страницу.</p><details><summary>Как установить расширение</summary><p>В текущей локальной версии: откройте chrome://extensions, включите «Режим разработчика», нажмите «Загрузить распакованное расширение» и выберите папку extension/dist проекта. Если расширение уже установлено, нажмите «Обновить» на его карточке.</p></details></>}
  </div>;
}
