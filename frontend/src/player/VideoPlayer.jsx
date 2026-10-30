import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { HTML5VideoAdapter } from './HTML5VideoAdapter.mjs';
import { PlaybackSync } from './PlaybackSync.mjs';
import ExtensionRoomAccess from './ExtensionRoomAccess.jsx';
import ExtensionInstall from './ExtensionInstall.jsx';
const DevDiagnostics = import.meta.env.DEV ? lazy(() => import('./DevDiagnostics.jsx')) : null;

const timeLabel = value => {
  if (!Number.isFinite(value)) return '0:00';
  const seconds = Math.floor(Math.max(0, value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function VideoPlayer({ roomId, initialState, socket, isOwner, ownerToken, connected, extensionInstalled = false, openingFilm = false, onOpenFilm, onExtensionDetected }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const syncRef = useRef(null);
  const propsRef = useRef(null);
  propsRef.current = { isOwner, ownerToken, connected };
  const queue = useRef(Promise.resolve());
  const commandRef = useRef(null);
  const reported = useRef(null);
  const [shared, setShared] = useState(initialState);
  const [url, setUrl] = useState(initialState.source?.url || '');
  const [mode, setMode] = useState(initialState.source?.type === 'extension' ? 'extension' : 'embedded');
  const [status, setStatus] = useState('Получаем состояние видео…');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(null);
  const [seekDraft, setSeekDraft] = useState(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  function command(action, payload = {}) {
    const sync = syncRef.current;
    const sourceId = sync?.state?.sourceId;
    const execute = async () => {
      if (!sync || sync.destroyed || !propsRef.current.isOwner || !propsRef.current.connected) return false;
      if (action !== 'source' && sync.state.sourceId !== sourceId) return false;
      try {
        const reply = await sync.request(`playback:${action}`, {
          ...payload, sourceId: sync.state.sourceId, expectedVersion: sync.state.version,
          ownerToken: propsRef.current.ownerToken
        });
        if (sync.destroyed) return false;
        if (reply.state) sync.accept(reply.state);
        if (!reply.ok) { setError(reply.error.message); return false; }
        setError('');
        return true;
      } catch {
        if (!sync.destroyed) { setError('Команда не подтверждена сервером. Проверьте подключение.'); void sync.refresh(); }
        return false;
      }
    };
    const result = queue.current.then(execute);
    queue.current = result.catch(() => {});
    return result;
  }
  commandRef.current = command;

  useEffect(() => {
    const adapter = new HTML5VideoAdapter(videoRef.current);
    const sync = new PlaybackSync({
      diagnostics: import.meta.env.DEV,
      adapter,
      request: (event, payload) => socket.timeout(5000).emitWithAck(event, payload),
      onState: setShared, onStatus: setStatus, onBlocked: setBlocked, onError: setError,
      onMetadata: () => {
        const state = sync.state;
        const duration = adapter.getDuration();
        if (!propsRef.current.isOwner || state?.source?.type !== 'html5' || !adapter.isReady() || !state?.sourceId || duration === null || duration > 604800 || reported.current === state.sourceId || state.duration !== null) return;
        reported.current = state.sourceId;
        void commandRef.current('metadata', { duration }).then(ok => { if (!ok && reported.current === state.sourceId) reported.current = null; });
      }
    });
    syncRef.current = sync;
    const receive = ({ roomId: incomingRoom, state }) => { if (incomingRoom === roomId) sync.accept(state); };
    socket.on('playback:state', receive);
    sync.accept(initialState);
    void sync.refresh();
    const timer = setInterval(() => {
      setPosition(adapter.getCurrentTime()); setDuration(adapter.getDuration());
      sync.onMetadata();
    }, 250);
    return () => { clearInterval(timer); socket.off('playback:state', receive); sync.destroy(); };
  }, [roomId, socket]);
  useEffect(() => { syncRef.current?.accept(initialState); }, [initialState]);
  useEffect(() => { syncRef.current?.setConnected(connected); if (connected) void syncRef.current?.refresh(); }, [connected]);
  useEffect(() => { setUrl(shared.source?.url || ''); setMode(shared.source?.type === 'extension' ? 'extension' : 'embedded'); setSeekDraft(null); }, [shared.sourceId]);

  async function userCommand(action, payload) {
    setPending(true);
    try { await command(action, payload); }
    finally { setPending(false); }
  }
  function seek(event) {
    const value = Number(event.currentTarget.value);
    setSeekDraft(null);
    setPosition(value);
    void userCommand('seek', { position: value });
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current.requestFullscreen();
    } catch { setError('Полноэкранный режим недоступен в этом браузере.'); }
  }
  return <section className="video-panel">
    <div className="video-container" ref={containerRef}>
      <video ref={videoRef} className={shared.source?.type === 'html5' ? 'shared-video' : 'shared-video hidden-video'} aria-label="Общее видео" playsInline preload="metadata" controls={false} onContextMenu={event => event.preventDefault()} />
      {shared.source?.type === 'extension' && <ExtensionRoomAccess source={shared.source} installed={extensionInstalled} busy={openingFilm} onOpen={onOpenFilm} onDetected={onExtensionDetected} />}
      {!shared.source && <div className="video-empty"><span className="screen-orbit" aria-hidden="true">▷</span><h2>Выбираем кино на вечер</h2><p>{isOwner ? 'Вставьте прямую ссылку на видео ниже.' : 'Владелец скоро добавит видео.'}</p></div>}
      {shared.source?.type === 'html5' && <div className="player-controls">
        <div className="timeline"><span>{timeLabel(seekDraft ?? position)}</span><input type="range" aria-label="Позиция видео" min="0" max={duration ?? shared.duration ?? 0} step="0.1" value={seekDraft ?? Math.min(position, duration ?? shared.duration ?? 0)} disabled={!isOwner || !connected || pending || !duration} onChange={event => setSeekDraft(Number(event.target.value))} onPointerUp={seek} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) seek(event); }} /><span>{timeLabel(duration ?? shared.duration)}</span></div>
        <div className="control-buttons">
          {isOwner ? <button className="quiet play-control" aria-label={shared.status === 'playing' ? 'Пауза для всех' : 'Воспроизвести для всех'} disabled={!connected || pending || !duration} onClick={() => void userCommand(shared.status === 'playing' ? 'pause' : 'play')}>{shared.status === 'playing' ? 'Ⅱ Пауза' : '▷ Смотреть'}</button> : <span className="viewer-label">{shared.status === 'playing' ? 'Общий просмотр' : shared.status === 'ended' ? 'Видео завершено' : 'Общая пауза'}</span>}
          <div className="local-controls"><button className="quiet" aria-label={muted ? 'Включить звук' : 'Выключить звук'} onClick={() => { videoRef.current.muted = !muted; setMuted(!muted); }}>{muted ? 'Без звука' : 'Звук'}</button><input type="range" aria-label="Локальная громкость" min="0" max="1" step="0.05" value={volume} onChange={event => { const value = Number(event.target.value); videoRef.current.volume = value; setVolume(value); }} /><button className="quiet" aria-label="Полноэкранный режим" onClick={fullscreen}>⛶</button></div>
        </div>
      </div>}
      {blocked && <div className="autoplay-prompt"><p>Браузеру нужно ваше разрешение на воспроизведение.</p><button className="primary" onClick={() => syncRef.current.startViewing()}>Начать просмотр</button></div>}
    </div>
    {mode === 'extension' && shared.source?.type !== 'extension' && <ExtensionInstall installed={extensionInstalled} onDetected={onExtensionDetected} />}
    <p className="sync-status" role="status">{shared.source?.type === 'extension' ? 'Extension · управляйте видео на его исходной странице' : connected ? status : 'Нет связи — восстанавливаем синхронизацию…'}</p>
    {error && <p className="message error" role="alert">{error}</p>}
    {DevDiagnostics && new URLSearchParams(location.search).get('diagnostics') === '1' && <Suspense fallback={null}><DevDiagnostics sync={syncRef.current} socket={socket} roomId={roomId} /></Suspense>}
    {isOwner && <form className="source-form panel" onSubmit={event => { event.preventDefault(); void userCommand('source', { url, mode }); }}><label htmlFor="player-mode">Режим просмотра</label><select id="player-mode" value={mode} onChange={event => setMode(event.target.value)}><option value="embedded">Embedded — прямой видеофайл</option><option value="extension">Extension — страница с видео</option></select><label htmlFor="video-url">{mode === 'extension' ? 'Ссылка на страницу с видео' : 'Прямая ссылка на видео'}</label><div className="source-input"><input id="video-url" type="url" placeholder={mode === 'extension' ? 'https://…/film' : 'https://…/film.mp4'} value={url} onChange={event => setUrl(event.target.value)} required maxLength={4096} /><button className="primary" disabled={!connected || pending}>{mode === 'extension' ? 'Выбрать страницу' : 'Загрузить видео'}</button></div><p className="hint">{mode === 'extension' ? 'Видео загружается самим сайтом. Для просмотра требуется локально установленное расширение 04agtogether.' : 'Прямые MP4, WebM и другие форматы вашего браузера.'}</p></form>}
  </section>;
}
