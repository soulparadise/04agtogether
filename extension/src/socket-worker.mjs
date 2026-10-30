import { RoomConnection } from './RoomConnection.mjs';
let connection;
let mutation = Promise.resolve();
const deliver = (binding, payload) => postMessage({ deliver: { binding, payload } });
const persist = () => postMessage({ persist: connection ? { pair: connection.pair, binding: connection.binding || null } : null });
async function handle(message) {
  if (message.type === 'create') {
    connection?.disconnect(); connection = null; persist();
    connection = await RoomConnection.createOwner(message.options, deliver); persist();
    return { ok: true, ...connection.status() };
  }
  if (message.type === 'pair') {
    connection?.disconnect(); connection = new RoomConnection(message.pair, deliver); connection.start();
    try { await connection.whenReady(); if (message.binding) connection.bind(message.binding); }
    catch (error) { connection.disconnect(); connection = null; persist(); throw error; }
    persist(); return { ok: true, ...connection.status() };
  }
  if (message.type === 'status') return connection?.status() || { connected: false, player: 'Откройте страницу фильма.' };
  if (message.type === 'selection') return connection?.select(message.selection) || { ok: false };
  if (message.type === 'configure-access') return connection?.configureAccess(message.settings) || { ok: false };
  if (message.type === 'set-source') return connection?.setSource(message.options) || { ok: false };
  if (message.type === 'bind') { if (!connection) throw new Error('Комната не подключена.'); connection.bind(message.binding); persist(); return { ok: true }; }
  if (message.type === 'disconnect') { connection?.disconnect(); connection = null; persist(); return { ok: true }; }
  if (message.type === 'reconnect') { connection?.start(); if (connection) await connection.whenReady(); return { ok: Boolean(connection) }; }
  if (message.type === 'content') return await connection?.content(message.sender, message.payload) || { ok: false };
  return { ok: false };
}
self.onmessage = ({ data: { id, message } }) => {
  const execute = async () => {
    try { postMessage({ id, result: await handle(message) }); }
    catch (error) { postMessage({ id, result: { ok: false, error: { message: error.message || 'Не удалось подключить комнату.' } } }); }
  };
  if (['create', 'pair', 'bind', 'disconnect'].includes(message.type)) mutation = mutation.then(execute, execute);
  else void execute();
};
