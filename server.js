'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const BRIDGE_VERSION = 'V7';
const ROOM_ONLINE_TTL_MS = Math.max(45000, Number(process.env.ROOM_ONLINE_TTL_MS || 100000));
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

function persistentRoom(room) {
  return {
    id: room.id,
    tokenHash: room.tokenHash,
    ip: room.ip,
    port: room.port,
    name: room.name,
    language: room.language,
    capacity: room.capacity,
    players: room.online ? room.players : 0,
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
        mapId: intValue(stored.mapId, 0, 0, 2147483646),
        hasPassword: bool01(stored.hasPassword),
        friends: bool01(stored.friends),
        online: false,
        createdAt: intValue(stored.createdAt, Date.now(), 0),
        updatedAt: intValue(stored.updatedAt, Date.now(), 0),
        lastSeen: intValue(stored.lastSeen, 0, 0),
        offlineAt: Date.now()
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
  room.mapId = intValue(q.get('mapId'), room.mapId || 0, 0, 2147483646);
  room.hasPassword = q.has('hasPassword') ? bool01(q.get('hasPassword')) : (room.hasPassword || '0');
  room.friends = q.has('friends') ? bool01(q.get('friends')) : (room.friends || '0');
  room.online = true;
  room.lastSeen = Date.now();
  room.updatedAt = Date.now();
  room.offlineAt = null;
}

function handleBridge(req, res, url) {
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
        room.online ? room.players : 0,
        room.mapName,
        room.hasPassword,
        '1',
        room.online ? '1' : '0'
      ].join('|');
      return notificationXml(rid, 'ROOM', message);
    }));
  }

  if (action === 'details') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!room) return ok(res, rid, 'ERROR', `ROOM_NOT_FOUND|${id}`);
    if (!room.online) return ok(res, rid, 'ERROR', `ROOM_OFFLINE|${id}`);

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

    markOffline(room, cleanText(q.get('reason'), 'host closed', 80));
    saveRooms();
    return ok(res, rid, 'OK', 'OFFLINE');
  }

  if (action === 'remove') {
    const id = intValue(q.get('id'), 0, 0, 2147483646);
    const room = rooms.get(id);
    if (!validRoomToken(room, q.get('token'))) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }
    rooms.delete(id);
    saveRooms();
    return ok(res, rid, 'OK', 'REMOVE');
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
    return handleBridge(req, res, url);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    cleanupRooms();
    const online = Array.from(rooms.values()).filter(room => room.online).length;
    const body = JSON.stringify({
      ok: true,
      service: 'BH Droid FS20 Multiplayer Server',
      bridge: BRIDGE_VERSION,
      rooms: rooms.size,
      roomsOnline: online,
      roomsOffline: rooms.size - online,
      roomOnlineTtlMs: ROOM_ONLINE_TTL_MS,
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BHFS20] server ${BRIDGE_VERSION} listening on ${PORT}`);
  console.log(`[BHFS20] room registry: ${ROOM_STATE_FILE}`);
});
