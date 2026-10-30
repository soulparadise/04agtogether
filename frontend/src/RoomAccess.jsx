import React, { useEffect, useState } from 'react';
export default function RoomAccess({ room, isOwner, onSave }) {
  const [enabled, setEnabled] = useState(Boolean(room.loginName));
  const [name, setName] = useState(room.loginName || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => { setName(room.loginName || ''); setEnabled(Boolean(room.loginName)); }, [room.id, room.loginName]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const reply = await onSave({ enabled, name, ...(password ? { password } : {}) });
      if (!reply?.ok) throw new Error(reply?.error?.message || 'Не удалось сохранить настройки входа.');
      setPassword(''); setMessage(enabled ? 'Вход настроен. Передайте друзьям имя и пароль отдельно.' : 'Вход по имени отключён. Приглашение по ссылке продолжает работать.');
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  return <div className="room-access">
    <p className="hint">По имени и паролю: {room.loginName ? <strong>{room.loginName}</strong> : 'не настроено'}</p>
    {isOwner && <details><summary>Настроить вход по имени и паролю</summary><form onSubmit={save}>
      <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Разрешить вход по имени и паролю</label>
      {enabled && <><label htmlFor="login-name">Имя комнаты для входа</label><input id="login-name" value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={64} required autoComplete="off" placeholder="Например, Кино у друзей" /><label htmlFor="new-room-password">{room.loginName ? 'Новый пароль (оставьте пустым, чтобы сохранить прежний)' : 'Пароль комнаты'}</label><input id="new-room-password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} maxLength={128} required={!room.loginName} autoComplete="new-password" /><p className="hint">От 8 символов. Сохранённый пароль посмотреть нельзя. Ссылка-приглашение работает без пароля.</p></>}
      <button className="quiet" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить вход'}</button>
    </form></details>}
    {error && <p className="message error" role="alert">{error}</p>}{message && <p className="hint" role="status">{message}</p>}
  </div>;
}
