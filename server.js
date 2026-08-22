'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 10000);
const ROOM_TTL_MS = 120000;
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

function pipeSafe(value, fallback = '-') {
  return field(value, fallback).replace(/\|/g, '/').replace(/[\r\n]/g, ' ');
}

function bool01(value) {
  const s = String(value == null ? '' : value).toLowerCase();
  return value === true || value === 1 || s === '1' || s === 'true' || s === 'yes' ? '1' : '0';
}

function intValue(value, fallback) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0].trim();
  if (!ip) ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '0.0.0.0';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || '0.0.0.0';
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.lastSeen > ROOM_TTL_MS) rooms.delete(id);
  }
}

// FS20 GiantsNotificationManager requires ALL of these values to exist.
// productId/version/isUpdate are mandatory even though the Lua bridge does not use them.
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
    'X-BH-FS20-Bridge': 'V5'
  });
  res.end(body);
}

function ok(res, rid, kind, message, url, image) {
  sendXml(res, [notificationXml(rid, kind, message, url, image)]);
}

function roomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function handleBridge(req, res, url) {
  cleanupRooms();

  const q = url.searchParams;
  const action = String(q.get('action') || '').toLowerCase();
  const rid = field(q.get('rid'), '0');

  if (action === 'ping') {
    return ok(res, rid, 'PING', 'OK');
  }

  if (action === 'register') {
    const id = nextRoomId++;
    const token = roomToken();
    const room = {
      id,
      token,
      ip: clientIp(req),
      port: intValue(q.get('port'), 10823),
      name: pipeSafe(q.get('name'), 'FS20 Game'),
      language: intValue(q.get('language'), 0),
      capacity: intValue(q.get('capacity'), 2),
      players: intValue(q.get('players'), 1),
      mapName: pipeSafe(q.get('mapName'), 'FS20 Map'),
      mapId: intValue(q.get('mapId'), 0),
      hasPassword: bool01(q.get('hasPassword')),
      friends: bool01(q.get('friends')),
      lastSeen: Date.now()
    };
    rooms.set(id, room);
    return ok(res, rid, 'REGISTER', `${id}|${token}`);
  }

  if (action === 'list') {
    const list = Array.from(rooms.values()).sort((a, b) => a.id - b.id);
    if (list.length === 0) {
      return ok(res, rid, 'EMPTY', '0');
    }

    const notifications = list.map(room => {
      const message = [
        room.id,
        room.name,
        room.language,
        room.capacity,
        room.players,
        room.mapName,
        room.hasPassword,
        '1'
      ].join('|');
      return notificationXml(rid, 'ROOM', message);
    });
    return sendXml(res, notifications);
  }

  if (action === 'details') {
    const id = intValue(q.get('id'), 0);
    const room = rooms.get(id);
    if (!room) {
      return ok(res, rid, 'ERROR', `ROOM_NOT_FOUND|${id}`);
    }

    const message = [
      room.id,
      room.name,
      room.language,
      room.capacity,
      room.players,
      room.mapName,
      room.mapId,
      room.hasPassword
    ].join('|');
    return ok(res, rid, 'DETAIL', message, room.ip, String(room.port || 10823));
  }

  if (action === 'heartbeat') {
    const id = intValue(q.get('id'), 0);
    const room = rooms.get(id);
    if (!room || field(q.get('token'), '') !== room.token) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }
    room.players = intValue(q.get('players'), room.players);
    room.lastSeen = Date.now();
    return ok(res, rid, 'OK', 'HEARTBEAT');
  }

  if (action === 'setinfo') {
    const id = intValue(q.get('id'), 0);
    const room = rooms.get(id);
    if (!room || field(q.get('token'), '') !== room.token) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }

    if (q.has('name')) room.name = pipeSafe(q.get('name'), room.name);
    if (q.has('hasPassword')) room.hasPassword = bool01(q.get('hasPassword'));
    if (q.has('capacity')) room.capacity = intValue(q.get('capacity'), room.capacity);
    if (q.has('players')) room.players = intValue(q.get('players'), room.players);
    if (q.has('friends')) room.friends = bool01(q.get('friends'));
    if (q.has('mapName')) room.mapName = pipeSafe(q.get('mapName'), room.mapName);
    if (q.has('mapId')) room.mapId = intValue(q.get('mapId'), room.mapId);
    room.lastSeen = Date.now();
    return ok(res, rid, 'OK', 'SETINFO');
  }

  if (action === 'remove') {
    const id = intValue(q.get('id'), 0);
    const room = rooms.get(id);
    if (!room || field(q.get('token'), '') !== room.token) {
      return ok(res, rid, 'ERROR', `INVALID_ROOM_OR_TOKEN|${id}`);
    }
    rooms.delete(id);
    return ok(res, rid, 'OK', 'REMOVE');
  }

  return ok(res, rid, 'ERROR', `UNKNOWN_ACTION|${pipeSafe(action, 'none')}`);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  if (url.pathname === '/bridge') {
    return handleBridge(req, res, url);
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    cleanupRooms();
    const body = JSON.stringify({
      ok: true,
      service: 'BH Droid FS20 Multiplayer Server',
      bridge: 'V5',
      rooms: rooms.size,
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BHFS20] server V5 listening on ${PORT}`);
});
