import React, { useEffect, useState } from 'react';

const display = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
export default function DevDiagnostics({ sync, socket, roomId }) {
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [breaking, setBreaking] = useState(false);
  useEffect(() => {
    const receive = report => { if (report.roomId === roomId && report.sourceId === sync?.state?.sourceId) setRemote(report); };
    socket.on('dev:metrics', receive);
    const unsubscribe = sync?.subscribeDiagnostics(metric => {
      if (metric?.sourceId && metric.sampledAtServer !== null && socket.connected) socket.emit('dev:metrics', metric);
    });
    const timer = setInterval(() => {
      const metric = sync?.getDiagnostics();
      setLocal(metric);
    }, 1000);
    return () => { clearInterval(timer); unsubscribe?.(); socket.off('dev:metrics', receive); };
  }, [sync, socket, roomId]);
  useEffect(() => {
    if (!breaking) return;
    socket.disconnect();
    const timer = setTimeout(() => { socket.connect(); setBreaking(false); }, 3000);
    return () => clearTimeout(timer);
  }, [breaking, socket]);
  const owner = remote?.samples.find(sample => sample.role === 'owner');
  const viewers = remote?.samples.filter(sample => sample.role === 'viewer') || [];
  const project = sample => Math.min(604800, sample.position + (sample.playing && !sample.buffering && !sample.autoplayBlocked ? Math.max(0, remote.serverNow - sample.sampledAtServer) / 1000 : 0));
  return <details className="dev-diagnostics" open>
    <summary>Диагностика сети · только разработка</summary>
    <p>Локальная позиция: <output data-metric="position">{display(local?.position)}</output> с · RTT: <output data-metric="rtt">{display(local?.rtt, 0)}</output> мс · Коррекций: <output data-metric="corrections">{local?.corrections ?? 0}</output></p>
    <p>Восстановление после подключения: <output data-metric="resync">{display(local?.resyncMs, 0)}</output> мс · С учётом разрыва: {display(local?.recoveryMs, 0)} мс</p>
    <p>Отклонение от серверной оценки: {display(local?.drift)} с {local?.buffering && '· буферизация'} {local?.autoplayBlocked && '· ждём пользовательский запуск'}</p>
    <p>Измеренная позиция владельца: <output data-metric="owner-position">{display(owner?.position)}</output> с</p>
    {viewers.map(viewer => <p key={viewer.participantId}>Зритель {viewer.participantId.slice(0, 5)}: {display(viewer.position)} с · Δ сырых замеров: {display(owner ? Math.abs(owner.position - viewer.position) : null)} с · оценка Δ в один момент: {display(owner ? Math.abs(project(owner) - project(viewer)) : null)} с</p>)}
    <p>Сырые удалённые замеры неодновременны. Оценка Δ использует время замера и режим плеера; это не покадровое измерение. Для сравнения нужны diagnostics=1 у обоих участников.</p>
    <nav aria-label="Профиль тестовой задержки">{['none', '100', '300', '500', 'jitter'].map(profile => <a key={profile} href={`${location.pathname}?diagnostics=1&network=${profile}`}>{profile === 'none' ? 'Без задержки' : profile === 'jitter' ? 'Jitter' : `${profile} мс/сторона`}</a>)}</nav>
    <button className="quiet" disabled={breaking} onClick={() => setBreaking(true)}>{breaking ? 'Соединение прервано…' : 'Прервать своё соединение на 3 с'}</button>
    <p>Общий тестовый MP4: <code>{location.origin}/test-media/sync-test.mp4</code></p>
  </details>;
}
