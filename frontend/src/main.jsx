import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

function App() {
  const [status, setStatus] = useState('Проверяем соединение…');
  useEffect(() => {
    const socket = io({ transports: ['polling'], upgrade: false });
    socket.on('connect', () => setStatus('Соединение установлено'));
    socket.on('connect_error', () => setStatus('Сервер временно недоступен'));
    socket.on('disconnect', () => setStatus('Восстанавливаем соединение…'));
    return () => socket.disconnect();
  }, []);
  return <main>
    <p className="eyebrow">SOULPARADISE · 04AGTOGETHER</p>
    <h1>На одной волне.</h1>
    <p className="intro">Место для совместного просмотра. Готовим пространство, в котором расстояние не мешает быть рядом.</p>
    <p className="status" role="status"><span aria-hidden="true">●</span> {status}</p>
    <footer>Скоро здесь появится что-то общее.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
