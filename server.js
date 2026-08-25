'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const BRIDGE_VERSION = 'V23_AGGRESSIVE_LOW_LATENCY_FS20';
const WS_PATH = '/relay';
const wssRooms = new Map(); // FS20 roomId -> live WSS relay room on the same Render service
let nextStreamId = 1;
const ROOM_ONLINE_TTL_MS = Math.max(45000, Number(process.env.ROOM_ONLINE_TTL_MS || 100000));
const RELAY_GUEST_IDLE_TTL_MS = Math.max(60000, Number(process.env.RELAY_GUEST_IDLE_TTL_MS || 90000));
// Low-latency relay policy: FS20/ENet expects UDP-like behavior. WebSocket runs over
// TCP, so an unbounded send queue turns packet loss/jitter into seconds of stale input.
// During initial world sync we allow a larger queue; after that we keep it very small
// and drop whole ENet datagrams under congestion. Reliable ENet traffic will retransmit;
// stale movement/state datagrams should be discarded instead of queued.
const RELAY_STARTUP_GRACE_MS = Math.max(5000, Number(process.env.RELAY_STARTUP_GRACE_MS || 18000));
const RELAY_STARTUP_MAX_BUFFERED_BYTES = Math.max(64 * 1024, Number(process.env.RELAY_STARTUP_MAX_BUFFERED_BYTES || 512 * 1024));
const RELAY_G2H_MAX_BUFFERED_BYTES = Math.max(4 * 1024, Number(process.env.RELAY_G2H_MAX_BUFFERED_BYTES || 8 * 1024));
const RELAY_H2G_MAX_BUFFERED_BYTES = Math.max(8 * 1024, Number(process.env.RELAY_H2G_MAX_BUFFERED_BYTES || 16 * 1024));
const ROOM_STATE_FILE = path.resolve(
  process.env.ROOM_STATE_FILE || path.join(process.cwd(), 'bhfs20-rooms.json')
);

const rooms = new Map();
let nextRoomId = 100001;

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function field(value, fallback = '-') {
  const text = String(value == null ? '' : value);
  return text.length > 0 ? text : fallback;
}

function cleanText(value, fallback, maxLength = 80) {
  return field(value, fallback)
    .replace(/\|/g, '/')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, maxLength);
}

function bool01(value) {
  const s = String(value == null ? '' : value).toLowerCase();
  return value === true || value === 1 || s === '1' || s === 'true' || s === 'yes' ? '1' : '0';
}

function intValue(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}


function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0].trim();
  if (!ip) ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '0.0.0.0';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return cleanText(ip, '0.0.0.0', 100);
}

function roomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function isClientToken(value) {
  return /^[0-9a-f]{32,128}$/i.test(String(value || ''));
}

function validRoomToken(room, suppliedToken) {
  if (!room || !isClientToken(suppliedToken) || !/^[0-9a-f]{64}$/i.test(String(room.tokenHash || ''))) {
    return false;
  }

  const expected = Buffer.from(room.tokenHash, 'hex');
  const actual = Buffer.from(tokenHash(suppliedToken), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}


function effectiveOnline(room) {
  return !!(room && room.online && room.relayOnline === true);
}

function normalizeRelayRoomId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{6,12}$/.test(text)) return null;
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id < 100001) return null;
  return String(id);
}

function wsSafeSend(ws, data, options) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data, options);
    return true;
  }
  return false;
}

function wsPendingBytes(ws) {
  if (!ws) return 0;
  const wsBuffered = Number(ws.bufferedAmount || 0);
  const socketBuffered = ws._socket ? Number(ws._socket.writableLength || 0) : 0;
  return Math.max(wsBuffered, socketBuffered);
}

function relayQueueLimit(guest, direction) {
  const ageMs = Date.now() - Number((guest && guest.joinedAt) || 0);
  if (ageMs >= 0 && ageMs < RELAY_STARTUP_GRACE_MS) {
    return RELAY_STARTUP_MAX_BUFFERED_BYTES;
  }
  // After world sync, input must win over completeness. guest->host carries the
  // driver's newest steering/pedal datagrams, so keep an especially shallow
  // queue. host->guest gets a little more room for authoritative state.
  return direction === 'g2h'
    ? RELAY_G2H_MAX_BUFFERED_BYTES
    : RELAY_H2G_MAX_BUFFERED_BYTES;
}

function wsRealtimeSend(ws, data, options, live, guest, direction) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const pending = wsPendingBytes(ws);
  const limit = relayQueueLimit(guest, direction);
  if (live) {
    live.maxBufferedBytes = Math.max(Number(live.maxBufferedBytes || 0), pending);
  }

  if (pending > limit) {
    if (live) {
      if (direction === 'h2g') live.droppedHostToGuests = Number(live.droppedHostToGuests || 0) + 1;
      else live.droppedGuestsToHost = Number(live.droppedGuestsToHost || 0) + 1;

      const drops = direction === 'h2g' ? live.droppedHostToGuests : live.droppedGuestsToHost;
      if (drops <= 5 || drops % 250 === 0) {
        console.warn(`[BHFS20/WSS] realtime drop room=${live.roomId} dir=${direction} stream=${guest ? guest.streamId : 0} pending=${pending} limit=${limit} drops=${drops}`);
      }
    }
    return false;
  }

  ws.send(data, options);
  return true;
}

function wsSendJson(ws, obj) {
  return wsSafeSend(ws, JSON.stringify(obj));
}

function allocStreamId() {
  for (let i = 0; i < 0xFFFFFFFF; i++) {
    const id = nextStreamId >>> 0;
    nextStreamId = (nextStreamId + 1) >>> 0;
    if (id !== 0) return id;
  }
  return crypto.randomBytes(4).readUInt32BE(0) || 1;
}

function parseRelayFrame(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length < 6 || b[0] !== 1 || b[1] !== 1) return null;
  return { buffer: b, streamId: b.readUInt32BE(2) };
}

function refreshRelayPlayers(roomId) {
  const live = wssRooms.get(String(roomId));
  const persistent = rooms.get(Number(roomId));
  if (!persistent) return;
  persistent.relayOnline = !!(live && live.host && live.host.readyState === WebSocket.OPEN);
  persistent.players = persistent.relayOnline ? 1 + live.guests.size : 0;
  persistent.updatedAt = Date.now();
}

function removeRelayGuest(live, streamId, reason = 'guest disconnected', closeSocket = false) {
  if (!live) return false;
  streamId = Number(streamId || 0);
  if (!streamId) return false;
  const guest = live.guests.get(streamId);
  if (!guest) return false;

  live.guests.delete(streamId);
  const roomId = String(live.roomId);
  wsSendJson(live.host, { type: 'guest_left', roomId, streamId, reason });

  if (guest.ws) {
    if (guest.ws.bhRoomId === roomId && Number(guest.ws.bhStreamId || 0) === streamId) {
      guest.ws.bhRole = null;
      guest.ws.bhRoomId = null;
      guest.ws.bhStreamId = 0;
    }
    if (closeSocket && guest.ws.readyState === WebSocket.OPEN) {
      try { guest.ws.close(4000, String(reason).slice(0, 100)); } catch (_) {}
    }
  }

  refreshRelayPlayers(roomId);
  saveRooms();
  console.log(`[BHFS20/WSS] guest left room=${roomId} stream=${streamId} reason=${reason}`);
  return true;
}

function closeRelayGuest(ws, reason = 'guest disconnected') {
  const roomId = ws && ws.bhRoomId ? String(ws.bhRoomId) : null;
  const streamId = ws && ws.bhStreamId ? Number(ws.bhStreamId) : 0;
  if (!roomId || !streamId) return false;
  const live = wssRooms.get(roomId);
  if (!live) return false;
  const guest = live.guests.get(streamId);
  if (!guest || guest.ws !== ws) return false;
  return removeRelayGuest(live, streamId, reason, false);
}

function dropRelayGuestsByInstallId(live, installId, exceptWs = null, reason = 'guest rejoin') {
  installId = String(installId || '');
  if (!live || !installId) return 0;
  let removed = 0;
  for (const [streamId, guest] of Array.from(live.guests.entries())) {
    if (String(guest.installId || '') !== installId) continue;
    const closeSocket = !!(guest.ws && guest.ws !== exceptWs);
    if (removeRelayGuest(live, streamId, reason, closeSocket)) removed++;
  }
  return removed;
}

function closeRelayRoom(roomId, reason = 'host disconnected', terminateHost = false) {
  roomId = String(roomId);
  const live = wssRooms.get(roomId);
  if (!live) {
    const persistent = rooms.get(Number(roomId));
    if (persistent) persistent.relayOnline = false;
    return;
  }
  wssRooms.delete(roomId);
  for (const guest of live.guests.values()) {
    wsSendJson(guest.ws, { type: 'room_closed', roomId, reason });
    try { guest.ws.close(1012, reason); } catch (_) {}
  }
  if (terminateHost && live.host) {
    try { live.host.close(1000, reason); } catch (_) {}
  }
  const persistent = rooms.get(Number(roomId));
  if (persistent) {
    persistent.relayOnline = false;
    persistent.players = 0;
    persistent.updatedAt = Date.now();
  }
  saveRooms();
  console.log(`[BHFS20/WSS] relay room offline ${roomId}: ${reason}`);
}

function handleRelayHostBinary(ws, data) {
  const frame = parseRelayFrame(data);
  if (!frame) return;
  const live = wssRooms.get(String(ws.bhRoomId || ''));
  if (!live || live.host !== ws) return;
  const guest = live.guests.get(frame.streamId);
  if (!guest) return;
  const sent = wsRealtimeSend(guest.ws, frame.buffer, { binary: true }, live, guest, 'h2g');
  guest.lastActivityAt = Date.now();
  if (sent) live.bytesHostToGuests += frame.buffer.length - 6;
  live.lastActivityAt = Date.now();
}

function handleRelayGuestBinary(ws, data) {
  const frame = parseRelayFrame(data);
  if (!frame || frame.streamId !== Number(ws.bhStreamId || 0)) return;
  const live = wssRooms.get(String(ws.bhRoomId || ''));
  if (!live || !live.host || live.host.readyState !== WebSocket.OPEN) return;
  const guest = live.guests.get(frame.streamId);
  if (!guest || guest.ws !== ws) return;
  guest.lastActivityAt = Date.now();
  const sent = wsRealtimeSend(live.host, frame.buffer, { binary: true }, live, guest, 'g2h');
  if (sent) live.bytesGuestsToHost += frame.buffer.length - 6;
  live.lastActivityAt = Date.now();
}

function handleRelayText(ws, text) {
  let msg;
  try { msg = JSON.parse(text); }
  catch (_) { return wsSendJson(ws, { type: 'error', code: 'BAD_JSON' }); }
  if (!msg || typeof msg.type !== 'string') return wsSendJson(ws, { type: 'error', code: 'BAD_MESSAGE' });

  if (msg.type === 'host_register') {
    const roomId = normalizeRelayRoomId(msg.roomId);
    if (!roomId) return wsSendJson(ws, { type: 'error', code: 'BAD_ROOM_ID' });
    const persistent = rooms.get(Number(roomId));
    const roomKey = String(msg.roomKey || '');
    if (!persistent || !validRoomToken(persistent, roomKey)) {
      return wsSendJson(ws, { type: 'error', code: 'INVALID_ROOM_OR_TOKEN' });
    }

    const old = wssRooms.get(roomId);
    if (old && old.host !== ws) closeRelayRoom(roomId, 'host reconnected', true);

    const maxPlayers = Math.max(2, Math.min(16, Number(msg.maxPlayers || persistent.capacity || 8)));
    const live = {
      roomId,
      roomKey,
      roomName: String(msg.roomName || persistent.name || `FS20 ${roomId}`).slice(0, 80),
      passwordHash: String(msg.password || '') ? tokenHash(String(msg.password || '')) : String(msg.passwordHash || ''),
      maxPlayers,
      mapId: String(msg.mapId || persistent.mapId || 'MapUS').slice(0, 80),
      host: ws,
      hostInstallId: String(msg.installId || '').slice(0, 160),
      guests: new Map(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      bytesHostToGuests: 0,
      bytesGuestsToHost: 0,
      droppedHostToGuests: 0,
      droppedGuestsToHost: 0,
      maxBufferedBytes: 0
    };
    wssRooms.set(roomId, live);
    ws.bhRole = 'host';
    ws.bhRoomId = roomId;
    ws.bhStreamId = 0;

    persistent.relayOnline = true;
    persistent.online = true;
    persistent.lastSeen = Date.now();
    persistent.offlineAt = null;
    persistent.name = live.roomName;
    persistent.capacity = maxPlayers;
    persistent.mapId = live.mapId;
    persistent.players = 1;
    saveRooms();

    console.log(`[BHFS20/WSS] host online room=${roomId} map=${live.mapId} max=${maxPlayers}`);
    return wsSendJson(ws, {
      type: 'room_registered', roomId, roomName: live.roomName,
      maxPlayers, players: 1, passwordRequired: !!live.passwordHash,
      online: true, mapId: live.mapId, relayProtocol: 1
    });
  }

  if (msg.type === 'join') {
    const roomId = normalizeRelayRoomId(msg.roomId);
    const live = roomId ? wssRooms.get(roomId) : null;
    if (!live || !live.host || live.host.readyState !== WebSocket.OPEN) {
      return wsSendJson(ws, { type: 'join_denied', code: 'ROOM_OFFLINE' });
    }

    // V22: a V21 podia deixar um stream antigo preso quando o jogo nativo
    // rejeitava o handshake. Uma nova tentativa do MESMO aparelho substitui
    // imediatamente o stream anterior, antes do teste de sala cheia.
    const installId = String(msg.installId || '').slice(0, 160);
    if (ws.bhRole === 'guest' && ws.bhRoomId && ws.bhStreamId) {
      closeRelayGuest(ws, 'guest rejoin same socket');
    }
    const staleRemoved = dropRelayGuestsByInstallId(live, installId, ws, 'guest rejoin replaced stale stream');
    if (staleRemoved > 0) {
      console.log(`[BHFS20/WSS] rejoin cleanup room=${roomId} install=${installId ? 'set' : 'empty'} removed=${staleRemoved}`);
    }

    if (1 + live.guests.size >= live.maxPlayers) {
      return wsSendJson(ws, { type: 'join_denied', code: 'ROOM_FULL' });
    }
    const suppliedPassword = String(msg.password || '');
    const suppliedHash = suppliedPassword ? tokenHash(suppliedPassword) : String(msg.passwordHash || '');
    if (live.passwordHash && suppliedHash !== live.passwordHash) {
      return wsSendJson(ws, { type: 'join_denied', code: 'BAD_PASSWORD' });
    }

    const streamId = allocStreamId();
    live.guests.set(streamId, {
      ws, streamId, installId, joinedAt: Date.now(), lastActivityAt: Date.now()
    });
    ws.bhRole = 'guest';
    ws.bhRoomId = roomId;
    ws.bhStreamId = streamId;
    refreshRelayPlayers(roomId);
    saveRooms();

    wsSendJson(ws, {
      type: 'join_ok', roomId, roomName: live.roomName,
      streamId, mapId: live.mapId, relayProtocol: 1
    });
    wsSendJson(live.host, {
      type: 'guest_joined', roomId, streamId,
      installId
    });
    console.log(`[BHFS20/WSS] guest joined room=${roomId} stream=${streamId}`);
    return;
  }

  if ((msg.type === 'guest_leave' || msg.type === 'join_abort') && ws.bhRole === 'guest') {
    closeRelayGuest(ws, msg.type === 'join_abort' ? 'guest join aborted' : 'guest left');
    return wsSendJson(ws, { type: 'guest_left_ok' });
  }

  if (msg.type === 'room_status') {
    const roomId = normalizeRelayRoomId(msg.roomId);
    const live = roomId ? wssRooms.get(roomId) : null;
    return wsSendJson(ws, {
      type: 'room_status',
      room: live ? {
        roomId, roomName: live.roomName, maxPlayers: live.maxPlayers,
        players: 1 + live.guests.size, passwordRequired: !!live.passwordHash,
        online: live.host.readyState === WebSocket.OPEN, mapId: live.mapId
      } : { roomId, online: false }
    });
  }

  if (msg.type === 'host_close' && ws.bhRole === 'host' && ws.bhRoomId) {
    closeRelayRoom(ws.bhRoomId, 'host closed room', false);
    return;
  }

  if (msg.type === 'ping') return wsSendJson(ws, { type: 'pong', t: msg.t || Date.now() });
  return wsSendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
}

function persistentRoom(room) {
  return {
    id: room.id,
    tokenHash: room.tokenHash,
    ip: room.ip,
    port: room.port,
    name: room.name,
    language: room.language,
    capacity: room.capacity,
    players: effectiveOnline(room) ? room.players : 0,
    mapName: room.mapName,
    mapId: room.mapId,
    hasPassword: room.hasPassword,
    friends: room.friends,
    online: !!room.online,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    lastSeen: room.lastSeen,
    offlineAt: room.offlineAt || null
  };
}

function saveRooms() {
  try {
    fs.mkdirSync(path.dirname(ROOM_STATE_FILE), { recursive: true });
    const payload = {
      version: 1,
      nextRoomId,
      rooms: Array.from(rooms.values())
        .sort((a, b) => a.id - b.id)
        .map(persistentRoom)
    };
    const temporary = `${ROOM_STATE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temporary, ROOM_STATE_FILE);
    return true;
  } catch (error) {
    console.error(`[BHFS20] room state save failed: ${error.message}`);
    return false;
  }
}

function loadRooms() {
  try {
    const payload = JSON.parse(fs.readFileSync(ROOM_STATE_FILE, 'utf8'));
    const storedRooms = Array.isArray(payload.rooms) ? payload.rooms : [];
    let highestId = 100000;

    for (const stored of storedRooms) {
      const id = intValue(stored.id, 0, 100001, 2147483646);
      const storedHash = /^[0-9a-f]{64}$/i.test(String(stored.tokenHash || ''))
        ? String(stored.tokenHash).toLowerCase()
        : (isClientToken(stored.token) ? tokenHash(stored.token) : null);
      if (!id || !storedHash) continue;

      const capacity = intValue(stored.capacity, 2, 2, 16);
      rooms.set(id, {
        id,
        tokenHash: storedHash,
        ip: cleanText(stored.ip, '0.0.0.0', 100),
        port: intValue(stored.port, 10823, 1, 65535),
        name: cleanText(stored.name, 'FS20 Game', 80),
        language: intValue(stored.language, 0, 0, 1000),
        capacity,
        players: 0,
        mapName: cleanText(stored.mapName, 'FS20 Map', 100),
        mapId: cleanText(stored.mapId, 'MapUS', 80),
        hasPassword: bool01(stored.hasPassword),
        friends: bool01(stored.friends),
        online: false,
        createdAt: intValue(stored.createdAt, Date.now(), 0),
        updatedAt: intValue(stored.updatedAt, Date.now(), 0),
        lastSeen: intValue(stored.lastSeen, 0, 0),
        offlineAt: Date.now(),
        relayOnline: false
      });
      highestId = Math.max(highestId, id);
    }

    nextRoomId = Math.max(
      highestId + 1,
      intValue(payload.nextRoomId, highestId + 1, 100001, 2147483646)
    );
    console.log(`[BHFS20] restored ${rooms.size} persistent room(s) as offline`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[BHFS20] room state load failed: ${error.message}`);
    }
  }
}

function markOffline(room, reason) {
  if (!room) return false;
  const changed = room.online || room.players !== 0;
  room.online = false;
  room.relayOnline = false;
  room.players = 0;
  room.offlineAt = Date.now();
  room.updatedAt = Date.now();
  if (changed) console.log(`[BHFS20] room ${room.id} offline: ${reason}`);
  return changed;
}

function cleanupRooms() {
  const now = Date.now();
  let changed = false;
  for (const room of rooms.values()) {
    if (room.online && now - room.lastSeen > ROOM_ONLINE_TTL_MS) {
      changed = markOffline(room, 'heartbeat timeout') || changed;
    }
  }
  if (changed) saveRooms();
}

// FS20 GiantsNotificationManager requires every attribute and child below.
function notificationXml(rid, kind, message, url = '-', image = '-', date = '0') {
  const title = `BHFS20:${field(rid, '0')}:${field(kind, 'ERROR')}`;
  return [
    '<notification productId="0" version="0" isUpdate="false">',
    `<title>${xmlEscape(title)}</title>`,
    `<message>${xmlEscape(field(message, '-'))}</message>`,
    `<url>${xmlEscape(field(url, '-'))}</url>`,
    `<image>${xmlEscape(field(image, '-'))}</image>`,
    `<date>${xmlEscape(field(date, '0'))}</date>`,
    '</notification>'
  ].join('');
}

function sendXml(res, notifications) {
  const body = `<?xml version="1.0" encoding="utf-8"?><notifications>${notifications.join('')}</notifications>`;
  res.writeHead(200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-BH-FS20-Bridge': BRIDGE_VERSION
  });
  res.end(body);
}

function ok(res, rid, kind, message, url, image) {
  sendXml(res, [notificationXml(rid, kind, message, url, image)]);
}

function applyRoomInfo(room, q, req) {
  const capacity = intValue(q.get('capacity'), room.capacity || 2, 2, 16);
  room.ip = clientIp(req);
  room.port = intValue(q.get('port'), room.port || 10823, 1, 65535);
  room.name = cleanText(q.get('name'), room.name || 'FS20 Game', 80);
  room.language = intValue(q.get('language'), room.language || 0, 0, 1000);
  room.capacity = capacity;
  room.players = intValue(q.get('players'), room.players || 1, 0, capacity);
  room.mapName = cleanText(q.get('mapName'), room.mapName || 'FS20 Map', 100);
  room.mapId = cleanText(q.get('mapId'), room.mapId || 'MapUS', 80);
  room.hasPassword = q.has('hasPassword') ? bool01(q.get('hasPassword')) : (room.hasPassword || '0');
  room.friends = q.has('friends') ? bool01(q.get('friends')) : (room.friends || '0');
  room.online = true;
  room.lastSeen = Date.now();
  room.updatedAt = Date.now();
  room.offlineAt = null;
}

async function handleBridge(req, res, url) {
  cleanupRooms();

  const q = url.searchParams;
  const action = String(q.get('action') || '').toLowerCase();
  const rid = cleanText(q.get('rid'), '0', 40);

  if (action === 'ping') {
    return ok(res, rid, 'PING', 'OK');
  }

  if (action === 'register') {
    const requestedId = intValue(q.get('id'), 0, 0, 2147483646);
    const suppliedToken = String(q.get('token') || '');
    let id;
    let token;
    let room;
    let resumed = false;

    if (requestedId > 0 && suppliedToken) {
      room = rooms.get(requestedId);
      if (room && !validRoomToken(room, suppliedToken)) {
        return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${requestedId}`);
      }
      if (!room && !isClientToken(suppliedToken)) {
        return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${requestedId}`);
      }

      id = requestedId;
      token = suppliedToken;
      resumed = !!room;
      if (!room) {
        room = { id, tokenHash: tokenHash(token), createdAt: Date.now() };
      }
    } else {
      id = nextRoomId++;
      token = roomToken();
      room = { id, tokenHash: tokenHash(token), createdAt: Date.now() };
    }

    room.tokenHash = tokenHash(token);
    applyRoomInfo(room, q, req);
    rooms.set(id, room);
    nextRoomId = Math.max(nextRoomId, id + 1);
    saveRooms();
    console.log(`[BHFS20] room ${id} online (${resumed ? 'resumed' : 'registered'})`);
    return ok(res, rid, 'REGISTER', `${id}|${token}|${resumed ? 'RESUMED' : 'NEW'}`);
  }

  if (action === 'list') {
    const list = Array.from(rooms.values()).sort((a, b) => a.id - b.id);
    if (list.length === 0) {
      return ok(res, rid, 'EMPTY', '0');
    }

    return sendXml(res, list.map(room => {
      const message = [
        room.id,
        room.name,
        room.language,
        room.capacity,
        effectiveOnline(room) ? room.players : 0,
        room.mapName,
        room.hasPassword,
        '1',
        effectiveOnline(room) ? '1' : '0'
      ].join('|');
      return notificationXml(rid, 'ROOM', message);
    }));
  }

  if (action === 'details') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!room) return ok(res, rid, 'ERROR', `ROOM_NOT_FOUND|${id}`);
    if (!effectiveOnline(room)) return ok(res, rid, 'ERROR', `ROOM_OFFLINE|${id}`);

    const targetPort = room.port || 10823;
    const requesterIp = clientIp(req);
    console.log(`[BHFS20] details room=${room.id} client=${requesterIp} target=${room.ip}:${targetPort}`);

    const message = [
      room.id,
      room.name,
      room.language,
      room.capacity,
      room.players,
      room.mapName,
      room.mapId,
      room.hasPassword,
      '1'
    ].join('|');
    return ok(res, rid, 'DETAIL', message, room.ip, String(targetPort));
  }

  if (action === 'heartbeat') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!validRoomToken(room, q.get('token'))) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }

    room.ip = clientIp(req);
    room.players = intValue(q.get('players'), room.players || 1, 0, room.capacity);
    const liveRelay = wssRooms.get(String(id));
    if (liveRelay && liveRelay.host && liveRelay.host.readyState === WebSocket.OPEN) {
      room.players = 1 + liveRelay.guests.size;
      room.relayOnline = true;
    }
    room.online = true;
    room.lastSeen = Date.now();
    room.updatedAt = Date.now();
    room.offlineAt = null;
    saveRooms();
    return ok(res, rid, 'OK', 'HEARTBEAT');
  }

  if (action === 'setinfo') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!validRoomToken(room, q.get('token'))) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }

    applyRoomInfo(room, q, req);
    saveRooms();
    return ok(res, rid, 'OK', 'SETINFO');
  }

  if (action === 'offline') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!validRoomToken(room, q.get('token'))) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }

    closeRelayRoom(String(id), cleanText(q.get('reason'), 'host closed', 80), true);
    markOffline(room, cleanText(q.get('reason'), 'host closed', 80));
    saveRooms();
    return ok(res, rid, 'OK', 'OFFLINE');
  }

  if (action === 'remove') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);

    // Idempotent cleanup: if an older client already removed the room, confirm
    // success so the mobile client can safely clear its local save->room state.
    if (!room) {
      console.log(`[BHFS20] remove id=${id} already absent`);
      return ok(res, rid, 'OK', `REMOVE_MISSING|${id}`);
    }

    if (!validRoomToken(room, q.get('token'))) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }

    const reason = cleanText(q.get('reason'), 'room removed', 80);
    closeRelayRoom(String(id), reason, true);
    rooms.delete(id);
    saveRooms();
    console.log(`[BHFS20] room ${id} removed reason=${reason}`);
    return ok(res, rid, 'OK', `REMOVE|${id}`);
  }

  return ok(res, rid, 'ERROR', `UNKNOWN_ACTION|${cleanText(action, 'none', 40)}`);
}

loadRooms();

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  if (req.method === 'GET' && url.pathname === '/bridge') {
    Promise.resolve(handleBridge(req, res, url)).catch(error => {
      console.error(`[BHFS20] bridge unhandled error: ${error.stack || error.message}`);
      if (!res.headersSent) ok(res, '0', 'ERROR', 'INTERNAL_ERROR');
      else if (!res.writableEnded) res.end();
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    cleanupRooms();
    const online = Array.from(rooms.values()).filter(effectiveOnline).length;
    const body = JSON.stringify({
      ok: true,
      service: 'BH Droid FS20 Multiplayer Server',
      bridge: BRIDGE_VERSION,
      rooms: rooms.size,
      roomsOnline: online,
      roomsOffline: rooms.size - online,
      roomOnlineTtlMs: ROOM_ONLINE_TTL_MS,
      relayMode: 'wss',
      relayPath: WS_PATH,
      relayRoomsOnline: wssRooms.size,
      relayStartupGraceMs: RELAY_STARTUP_GRACE_MS,
      relayStartupMaxBufferedBytes: RELAY_STARTUP_MAX_BUFFERED_BYTES,
      relayG2hMaxBufferedBytes: RELAY_G2H_MAX_BUFFERED_BYTES,
      relayH2gMaxBufferedBytes: RELAY_H2G_MAX_BUFFERED_BYTES,
      now: new Date().toISOString()
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

function shutdown(signal) {
  console.log(`[BHFS20] ${signal}: saving room registry`);
  saveRooms();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  perMessageDeflate: false,
  maxPayload: 1024 * 1024
});

wss.on('connection', (ws) => {
  // Force low-latency TCP behavior underneath WebSocket. This does not remove TCP
  // head-of-line blocking, but avoids adding Nagle delay on top of it.
  try {
    if (ws._socket) {
      ws._socket.setNoDelay(true);
      ws._socket.setKeepAlive(true, 10000);
    }
  } catch (_) {}

  ws.isAlive = true;
  ws.bhRole = null;
  ws.bhRoomId = null;
  ws.bhStreamId = 0;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        if (ws.bhRole === 'host') return handleRelayHostBinary(ws, data);
        if (ws.bhRole === 'guest') return handleRelayGuestBinary(ws, data);
        return;
      }
      handleRelayText(ws, data.toString('utf8'));
    } catch (error) {
      console.error('[BHFS20/WSS] message error:', error);
      wsSendJson(ws, { type: 'error', code: 'SERVER_ERROR' });
    }
  });

  ws.on('close', () => {
    if (ws.bhRole === 'host' && ws.bhRoomId) {
      const live = wssRooms.get(String(ws.bhRoomId));
      if (live && live.host === ws) closeRelayRoom(ws.bhRoomId, 'host disconnected', false);
    } else if (ws.bhRole === 'guest') {
      closeRelayGuest(ws);
    }
  });
  ws.on('error', error => console.error('[BHFS20/WSS] socket error:', error.message));
  wsSendJson(ws, { type: 'hello', service: 'bh-droid-fs20', relayProtocol: 1, wsPath: WS_PATH });
});

const wsHeartbeat = setInterval(() => {
  const now = Date.now();
  for (const live of wssRooms.values()) {
    for (const [streamId, guest] of Array.from(live.guests.entries())) {
      const lastActivityAt = Number(guest.lastActivityAt || guest.joinedAt || 0);
      if (lastActivityAt > 0 && now - lastActivityAt > RELAY_GUEST_IDLE_TTL_MS) {
        removeRelayGuest(live, streamId, 'guest relay idle timeout', true);
      }
    }
  }

  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);
server.on('close', () => clearInterval(wsHeartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BHFS20] server ${BRIDGE_VERSION} listening on ${PORT}; WSS ${WS_PATH}`);
});
