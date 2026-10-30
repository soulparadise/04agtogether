import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import VideoPlayer from './player/VideoPlayer.jsx';
import ExtensionInstall from './player/ExtensionInstall.jsx';
import RoomAccess from './RoomAccess.jsx';
import { roomAccessRequest } from './room-access.mjs';
import { developmentSocketOptions, developmentSearch } from './player/dev-network.mjs';
import { extensionRequest, savedNickname, rememberNickname } from './extension-bridge.mjs';

const keyFor = id => `04agtogether:room:${id}`;
const memory = new Map();
function readSession(id) {
  try { return JSON.parse(sessionStorage.getItem(keyFor(id))) || memory.get(id); }
  catch { return memory.get(id); }
}
function saveSession(id, session) {
  memory.set(id, session);
  try { sessionStorage.setItem(keyFor(id), JSON.stringify(session)); return true; }
  catch { return false; }
}
function forgetSession(id) {
  memory.delete(id);
  try { sessionStorage.removeItem(keyFor(id)); } catch {}
}
const roomIdFrom = path => path.match(/^\/room\/([a-f0-9]{32})\/?$/)?.[1];

export default function App() {
  const socketRef = useRef(null);
  const handoff = useRef(false);
  const [path, setPath] = useState(location.pathname);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState(null);
  const [participantId, setParticipantId] = useState(null);
  const [nickname, setNickname] = useState(savedNickname);
  const [extensionInstalled, setExtensionInstalled] = useState(false);
  const [extensionChecked, setExtensionChecked] = useState(false);
  const [extensionSourceStatus, setExtensionSourceStatus] = useState('');
  const [managed, setManaged] = useState(false);
  const [openingFilm, setOpeningFilm] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [copied, setCopied] = useState(false);
  const [entryMode, setEntryMode] = useState('create'), [loginName, setLoginName] = useState(''), [loginPassword, setLoginPassword] = useState('');
  const roomId = roomIdFrom(path);
  const me = room?.participants.find(member => member.id === participantId);
  const isOwner = me?.role === 'owner';
  const invitation = room ? `${location.origin}/room/${room.id}` : '';
  function navigate(next) { history.pushState(null, '', next + (import.meta.env.DEV ? developmentSearch() : '')); setPath(next); }
  async function request(event, payload) {
    if (!socketRef.current?.connected) throw new Error('Нет соединения с сервером. Дождитесь подключения.');
    try { return await socketRef.current.timeout(5000).emitWithAck(event, payload); }
    catch { throw new Error('Сервер не ответил. Попробуйте ещё раз после подключения.'); }
  }
  function accept(reply) {
    const stored = saveSession(reply.room.id, {
      participantId: reply.participantId, sessionToken: reply.sessionToken,
      ...(reply.ownerToken ? { ownerToken: reply.ownerToken } : {})
    });
    if (!stored) setNotice('Хранилище вкладки недоступно. После обновления страницы сессия не сохранится.');
    setRoom(reply.room); setParticipantId(reply.participantId); setTitle(reply.room.title); setError(''); setCopied(false);
  }
  function acceptExtension(reply) {
    handoff.current = true; setManaged(true);
    setExtensionSourceStatus(reply.connected === false ? 'Нет связи с расширением — переподключаемся…' : reply.player || 'Определяем источник…');
    setRoom(reply.room); setParticipantId(reply.participantId); setTitle(reply.room.title); setError('');
  }
  useEffect(() => {
    let cancelled = false;
    void extensionRequest({ type: 'profile' }, 1500).then(reply => {
      if (cancelled) return;
      setExtensionInstalled(reply.ok === true);
      if (!savedNickname() && reply.nickname) { setNickname(reply.nickname); rememberNickname(reply.nickname); }
    }).catch(() => {}).finally(() => { if (!cancelled) setExtensionChecked(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const socket = io({ transports: ['polling'], upgrade: false, ...(import.meta.env.DEV ? developmentSocketOptions() : {}) });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('room:session-replaced', ({ roomId: replacedRoomId }) => {
      if (handoff.current && replacedRoomId === roomIdFrom(location.pathname)) {
        setManaged(true); setNotice('Просмотр продолжается в расширении.'); setRestoring(false); return;
      }
      forgetSession(replacedRoomId);
      if (replacedRoomId === roomIdFrom(location.pathname)) {
        setRoom(null); setParticipantId(null); setRestoring(false);
        setError('Эта сессия продолжена в другой вкладке или расширении. Здесь можно войти отдельным зрителем.');
      }
    });
    socket.on('room:state', next => {
      if (next.id === roomIdFrom(location.pathname)) setRoom(previous => previous && previous.id === next.id && next.revision >= previous.revision ? next : previous);
    });
    socket.on('playback:state', ({ roomId: id, state }) => {
      setRoom(previous => previous?.id === id && state.version >= previous.playback.version ? { ...previous, playback: state } : previous);
    });
    const pop = () => {
      socket.emit('room:leave', {}, () => {});
      handoff.current = false; setManaged(false); setRoom(null); setParticipantId(null); setError(''); setPath(location.pathname);
    };
    window.addEventListener('popstate', pop);
    return () => { window.removeEventListener('popstate', pop); socket.disconnect(); };
  }, []);
  useEffect(() => {
    if (!roomId || !connected || !extensionChecked) { setRestoring(false); return; }
    const session = readSession(roomId);
    let cancelled = false;
    setRestoring(true);
    async function restore() {
      try {
        if (extensionInstalled) {
          const active = await extensionRequest({ type: 'room-status', roomId }, 3000);
          if (cancelled) return;
          if (active.ok && active.room) { acceptExtension(active); setRestoring(false); return; }
        }
        if (!session && !savedNickname()) { setRestoring(false); return; }
        const reply = await request(session ? 'room:resume' : 'room:join', session ? { roomId, ...session } : { roomId, nickname: savedNickname() });
        if (cancelled) return;
        if (reply.ok) accept(reply);
        else {
          setRoom(null); setParticipantId(null); setError(reply.error.message);
          if (['ROOM_NOT_FOUND', 'SESSION_EXPIRED', 'FORBIDDEN'].includes(reply.error.code)) forgetSession(roomId);
        }
      } catch (problem) { if (!cancelled) setError(problem.message); }
      if (!cancelled) setRestoring(false);
    }
    restore();
    return () => { cancelled = true; };
  }, [roomId, connected, extensionChecked, extensionInstalled]);
  useEffect(() => {
    if (!managed || !roomId || !extensionInstalled) return;
    let cancelled = false;
    const update = () => { void extensionRequest({ type: 'room-status', roomId }, 3000).then(reply => {
      if (cancelled) return;
      if (reply.ok && reply.room) acceptExtension(reply);
      else setNotice('Просмотр отключён или ожидает разрешения Chrome. Нажмите «Открыть фильм», чтобы продолжить.');
    }).catch(() => { if (!cancelled) setNotice('Связь с расширением потеряна. Проверьте, что оно включено.'); }); };
    update(); const timer = setInterval(update, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [managed, roomId, extensionInstalled]);
  async function enter(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      let reply;
      if (!roomId && entryMode === 'join') {
        const joined = await roomAccessRequest('join', { name: loginName, password: loginPassword, nickname });
        setLoginPassword('');
        if (!joined.ok) { setError(joined.error.message); return; }
        reply = await request('room:resume', { roomId: joined.room.id, participantId: joined.participantId, sessionToken: joined.sessionToken });
      } else reply = await request(roomId ? 'room:join' : 'room:create', { nickname, ...(roomId ? { roomId } : {}) });
      if (!reply.ok) { setError(reply.error.message); return; }
      accept(reply);
      rememberNickname(nickname.trim());
      // A new document gives Chrome's external-message sender the exact room
      // URL. pushState alone can leave the extension's document URL at '/'.
      if (!roomId) location.assign(`/room/${reply.room.id}` + (import.meta.env.DEV ? developmentSearch() : ''));
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  async function leave() {
    setBusy(true);
    try {
      const reply = managed ? await extensionRequest({ type: 'leave-room', roomId }) : await request('room:leave', {});
      if (!reply.ok) { setError(reply.error.message); return; }
      if (!isOwner && room) forgetSession(room.id);
      handoff.current = false; setManaged(false); setRoom(null); setParticipantId(null); setError(''); setNotice(''); navigate('/');
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  async function rename(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const reply = await request('room:update', { title, ownerToken: readSession(room.id)?.ownerToken });
      if (reply.ok) setRoom(reply.room); else setError(reply.error.message);
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  async function copyInvitation() {
    try { await navigator.clipboard.writeText(invitation); setCopied(true); }
    catch { setNotice('Не удалось скопировать автоматически. Выделите ссылку и скопируйте вручную.'); }
  }
  const inside = room && me;
  async function saveRoomAccess(settings) {
    const reply = managed
      ? await extensionRequest({ type: 'room-access', roomId: room.id, settings })
      : await roomAccessRequest('access', { ...settings, roomId: room.id, ...readSession(room.id) });
    if (reply.ok) setRoom(reply.room);
    return reply;
  }
  async function chooseManagedSource({ mode, url }) {
    return extensionRequest({ type: 'room-source', roomId: room.id, mode, url });
  }
  async function openFilm(source) {
    if (source?.type !== 'extension' || !source.url) { setError('Сначала выберите страницу фильма в режиме Extension.'); return; }
    setOpeningFilm(true); setError(''); handoff.current = true;
    try {
      const reply = await extensionRequest({ type: 'open-film', roomId: room.id, filmURL: source.url, session: readSession(room.id) });
      if (!reply.ok) throw new Error(reply.error?.message || 'Не удалось открыть фильм.');
      setManaged(true); setNotice(reply.needsPermission ? 'Разрешите доступ к сайту в окне расширения — фильм подключится автоматически.' : 'Просмотр продолжается в расширении.');
    } catch (problem) { if (!managed) handoff.current = false; setError(problem.message); }
    finally { setOpeningFilm(false); }
  }
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="04agtogether — главная"><span className="brand-mark" aria-hidden="true">◧</span>04agtogether</a><span className={`connection ${connected ? 'online' : ''}`} role="status"><i />{connected ? 'Соединение установлено' : 'Подключаемся…'}</span></header>
    <main>
      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message" role="status">{notice}</div>}
      {restoring && !inside ? <section className="join-card"><p className="eyebrow">ВОЗВРАЩАЕМСЯ</p><h1>Восстанавливаем сессию…</h1></section> : inside ? <>
        <div className="room-heading"><div><p className="eyebrow">ВАШ ОБЩИЙ КИНОЗАЛ</p><h1>{room.title}</h1><p className="room-id">Комната · {room.id}</p></div><button className="quiet" onClick={leave} disabled={!connected || busy}>Выйти из комнаты</button></div>
        <div className="room-layout">
          <VideoPlayer key={room.id} roomId={room.id} initialState={room.playback} socket={socketRef.current} isOwner={isOwner && !managed} onChooseSource={isOwner && managed ? chooseManagedSource : undefined} ownerToken={readSession(room.id)?.ownerToken} connected={connected && !managed} extensionInstalled={extensionInstalled} openingFilm={openingFilm} onOpenFilm={openFilm} onExtensionDetected={setExtensionInstalled} extensionSourceStatus={extensionSourceStatus} />
          <aside className="room-sidebar">
            <section className="panel"><p className="eyebrow">ПРИГЛАСИТЬ ДРУЗЕЙ</p><label htmlFor="invite">Ссылка на комнату</label><div className="invite-row"><input id="invite" value={invitation} readOnly onFocus={event => event.target.select()} /><button className="icon-button" onClick={copyInvitation} aria-label="Копировать ссылку">{copied ? '✓' : '⧉'}</button></div><p className="hint" role="status">{copied ? 'Ссылка скопирована' : 'Достаточно ссылки — регистрация не нужна.'}</p><RoomAccess room={room} isOwner={isOwner} onSave={saveRoomAccess} /></section>
            <section className="panel"><div className="section-heading"><h2>В комнате</h2><span className="count">{room.participants.filter(member => member.connected).length} онлайн</span></div><ul className="participants">{room.participants.map(member => <li key={member.id}><span className={`presence ${member.connected && connected ? 'present' : ''}`} /><div><strong>{member.nickname}{member.id === participantId && <small> · вы</small>}</strong><span className="member-status">{member.connected && connected ? 'На связи' : 'Не в сети'}</span></div><span className={`role ${member.role === 'owner' ? 'owner' : ''}`}>{member.role === 'owner' ? 'Владелец' : 'Зритель'}</span></li>)}</ul><p className="hint">{isOwner ? 'Вы управляете общим видео. Громкость у каждого своя.' : 'Общим просмотром управляет владелец комнаты.'}</p></section>
            {isOwner && !managed && <form className="panel rename" onSubmit={rename}><label htmlFor="room-title">Название комнаты</label><input id="room-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={80} required /><button className="quiet" disabled={!connected || busy}>Сохранить название</button></form>}
          </aside>
        </div>
      </> : <section className={`welcome ${roomId ? 'joining' : ''}`}><div className="welcome-copy"><p className="eyebrow">БЛИЖЕ, ДАЖЕ КОГДА ДАЛЕКО</p><h1>{roomId ? 'Вас ждут в комнате.' : <>Хорошее кино.<br />Своя компания.</>}</h1><p className="intro">{roomId ? 'Представьтесь друзьям, чтобы присоединиться к общему вечеру.' : 'Создайте уютное место для общего вечера. Пригласите друзей одной ссылкой — остальное скоро будет здесь.'}</p>
        {!roomId && <div className="entry-choice" role="group" aria-label="Способ подключения"><button className="quiet" aria-pressed={entryMode === 'create'} onClick={() => { setEntryMode('create'); setLoginPassword(''); setError(''); }}>Создать комнату</button><button className="quiet" aria-pressed={entryMode === 'join'} onClick={() => { setEntryMode('join'); setError(''); }}>Войти в комнату</button></div>}
        <form className="entry-form" onSubmit={enter}>
          {!roomId && entryMode === 'join' && <><label htmlFor="entry-room-name">Имя комнаты для входа</label><input id="entry-room-name" value={loginName} onChange={event => setLoginName(event.target.value)} minLength={3} maxLength={64} autoComplete="off" required /><label htmlFor="entry-room-password">Пароль комнаты</label><input id="entry-room-password" type="password" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} maxLength={128} autoComplete="current-password" required /></>}
          <label htmlFor="nickname">Ваш никнейм</label><input id="nickname" placeholder="Как вас называть?" value={nickname} onChange={event => setNickname(event.target.value)} maxLength={32} autoComplete="nickname" required /><button className="primary" disabled={!connected || busy || restoring}>{busy ? 'Подождите…' : roomId || entryMode === 'join' ? 'Войти в комнату' : 'Создать комнату'}<span aria-hidden="true">↗</span></button></form>
        {roomId ? <button className="text-button" onClick={() => { setError(''); navigate('/'); }}>Вернуться на главную</button> : <p className="footnote">Без регистрации · Только ваша компания</p>}
        {!roomId && path !== '/' && <p className="hint">Такой страницы нет. Здесь можно создать новую комнату.</p>}
      </div><div className="welcome-art" aria-hidden="true"><div className="film-frame"><span className="art-label">ВЕЧЕР ВМЕСТЕ</span><div className="play-symbol">▷</div><div className="art-line" /><span className="art-caption">Расстояние — просто число.</span></div><div className="art-note">МЕСТО РЯДОМ ВСЕГДА ЕСТЬ</div></div></section>}
      {!inside && <ExtensionInstall installed={extensionInstalled} onDetected={setExtensionInstalled} compact />}
    </main><footer>На одной волне.<span>Сделано для общих вечеров.</span></footer>
  </div>;
}
