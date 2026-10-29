// Registered only by the source development entry point, never by production.
function registerDevDiagnostics(socket, { io, current, channel, clock }) {
  socket.on('dev:metrics', (payload, ack = () => {}) => {
    if (typeof ack !== 'function') ack = () => {};
    const active = current(socket);
    if (!active || !payload || typeof payload !== 'object') { ack({ ok: false }); return; }
    const { room, member } = active;
    if (!room.playback.sourceId || payload.sourceId !== room.playback.sourceId) { ack({ ok: false }); return; }
    const numeric = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
    if (!numeric(payload.position, 604800) || !numeric(payload.sampledAtServer, Number.MAX_SAFE_INTEGER)) { ack({ ok: false }); return; }
    room.devMetrics ??= new Map();
    const now = clock();
    if (now - (room.devMetrics.get(member.id)?.receivedAt ?? -Infinity) < 500) { ack({ ok: false }); return; }
    // Explicit allowlist: no credentials, URLs or caller-supplied roles are echoed.
    room.devMetrics.set(member.id, {
      participantId: member.id, role: member.id === room.ownerId ? 'owner' : 'viewer',
      sourceId: room.playback.sourceId,
      position: payload.position, sampledAtServer: payload.sampledAtServer, receivedAt: now,
      playing: payload.playing === true, buffering: payload.buffering === true,
      autoplayBlocked: payload.autoplayBlocked === true,
      rtt: numeric(payload.rtt, 120000) ? payload.rtt : null,
      corrections: numeric(payload.corrections, 1e9) ? payload.corrections : 0,
      recoveryMs: numeric(payload.recoveryMs, 1e9) ? payload.recoveryMs : null,
      resyncMs: numeric(payload.resyncMs, 1e9) ? payload.resyncMs : null
    });
    const samples = [...room.devMetrics.values()].filter(sample => sample.sourceId === room.playback.sourceId && room.participants.get(sample.participantId)?.socketId && now - sample.receivedAt < 5000);
    io.to(channel(room)).emit('dev:metrics', { roomId: room.id, sourceId: room.playback.sourceId, serverNow: now, samples });
    ack({ ok: true });
  });
}
module.exports = { registerDevDiagnostics };
