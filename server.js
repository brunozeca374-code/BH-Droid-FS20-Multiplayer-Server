"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const SERVER_NAME = process.env.SERVER_NAME || "Servidor Multijogador BH Droid FS20";
const API_PREFIX = "/api/fs20/v1";
const ROOM_TTL_MS = Number.parseInt(process.env.ROOM_TTL_MS || "120000", 10);
const BRIDGE_PRODUCT_ID = "7BF003BA";
const BRIDGE_VERSION = "1.5.1.0";
const rooms = new Map();

function nowIso() { return new Date().toISOString(); }
function xmlEscape(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
function safeField(v, max = 128) {
  return String(v ?? "").replace(/[|\r\n]/g, " ").trim().slice(0, max);
}
function toInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function toBool(v, fallback = false) {
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return fallback;
}
function sourceIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}
function newRoomId() {
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomInt(10000000, 99999999);
    if (!rooms.has(String(id))) return id;
  }
  return Date.now() % 90000000 + 10000000;
}
function newToken() { return crypto.randomBytes(18).toString("base64url"); }
function cleanupRooms() {
  const n = Date.now();
  for (const [id, room] of rooms) if (room.expiresAt <= n) rooms.delete(id);
}
setInterval(cleanupRooms, 30000).unref();

function send(res, status, type, body) {
  const b = Buffer.from(body);
  res.writeHead(status, {"content-type": type, "content-length": b.length, "cache-control": "no-store"});
  res.end(b);
}
function sendJson(res, status, payload) { send(res, status, "application/json; charset=utf-8", JSON.stringify(payload)); }
function notificationXml(items) {
  const body = items.map((item) => {
    return [
      `  <notification productId="${BRIDGE_PRODUCT_ID}" version="${BRIDGE_VERSION}" isUpdate="false">`,
      `    <title>${xmlEscape(item.title || "")}</title>`,
      `    <message>${xmlEscape(item.message || "")}</message>`,
      `    <url>${xmlEscape(item.url || "")}</url>`,
      `    <image>${xmlEscape(item.image || "")}</image>`,
      `    <date>${xmlEscape(item.date || "")}</date>`,
      "  </notification>"
    ].join("\n");
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<notifications>\n${body}${body ? "\n" : ""}</notifications>\n`;
}
function bridgeTitle(rid, kind) { return `BHFS20:${safeField(rid, 24)}:${kind}`; }
function roomSummary(room) {
  return {
    id: room.id, name: room.name, language: room.language, capacity: room.capacity,
    numPlayers: room.numPlayers, mapName: room.mapName, mapId: room.mapId,
    hasPassword: room.hasPassword, allModsAvailable: true, isLanServer: false,
    isFriendServer: false, ip: room.connectIp, port: room.connectPort, updatedAt: room.updatedAt
  };
}

function bridge(req, res, url) {
  cleanupRooms();
  const q = url.searchParams;
  const action = q.get("action") || "ping";
  const rid = q.get("rid") || "0";
  const items = [];

  if (action === "boot") {
    return send(res, 200, "application/xml; charset=utf-8", notificationXml([]));
  }

  if (action === "ping") {
    items.push({title: bridgeTitle(rid, "PING"), message: "OK", url: SERVER_NAME, date: nowIso()});
  } else if (action === "list") {
    const list = [...rooms.values()].filter(r => r.hostOnline).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    if (list.length === 0) {
      items.push({title: bridgeTitle(rid, "EMPTY"), message: "0"});
    } else {
      for (const r of list) {
        items.push({
          title: bridgeTitle(rid, "ROOM"),
          message: [r.id, safeField(r.name,64), r.language, r.capacity, r.numPlayers, safeField(r.mapName,64), r.hasPassword ? 1 : 0, 1, r.mapId].join("|"),
          url: r.connectIp,
          image: String(r.connectPort),
          date: r.updatedAt
        });
      }
    }
  } else if (action === "details") {
    const id = String(q.get("id") || "");
    const r = rooms.get(id);
    if (!r) {
      items.push({title: bridgeTitle(rid, "NOTFOUND"), message: id});
    } else {
      items.push({
        title: bridgeTitle(rid, "DETAIL"),
        message: [r.id, safeField(r.name,64), r.language, r.capacity, r.numPlayers, safeField(r.mapName,64), r.mapId, r.hasPassword ? 1 : 0].join("|"),
        url: r.connectIp,
        image: String(r.connectPort),
        date: r.updatedAt
      });
    }
  } else if (action === "register") {
    const id = newRoomId();
    const token = newToken();
    const n = Date.now();
    const room = {
      id,
      token,
      name: safeField(q.get("name") || "FS20 Game", 64),
      language: toInt(q.get("language"), 0, 0, 255),
      capacity: toInt(q.get("capacity"), 2, 1, 16),
      numPlayers: toInt(q.get("players"), 1, 0, 16),
      mapName: safeField(q.get("mapName") || "FS20 Map", 64),
      mapId: toInt(q.get("mapId"), 0, 0, 65535),
      hasPassword: toBool(q.get("hasPassword"), false),
      allowOnlyFriends: toBool(q.get("friends"), false),
      connectIp: safeField(q.get("ip") || sourceIp(req), 128),
      connectPort: toInt(q.get("port"), 10823, 1, 65535),
      hostOnline: true,
      createdAt: new Date(n).toISOString(),
      updatedAt: new Date(n).toISOString(),
      expiresAt: n + ROOM_TTL_MS
    };
    rooms.set(String(id), room);
    items.push({title: bridgeTitle(rid, "REGISTER"), message: `${id}|${token}`, url: room.connectIp, image: String(room.connectPort), date: room.updatedAt});
  } else if (action === "heartbeat" || action === "setinfo") {
    const id = String(q.get("id") || "");
    const token = String(q.get("token") || "");
    const r = rooms.get(id);
    if (!r || !token || token !== r.token) {
      items.push({title: bridgeTitle(rid, "DENIED"), message: id});
    } else {
      const n = Date.now();
      r.numPlayers = toInt(q.get("players"), r.numPlayers, 0, r.capacity);
      if (q.has("name")) r.name = safeField(q.get("name"), 64);
      if (q.has("capacity")) r.capacity = toInt(q.get("capacity"), r.capacity, 1, 16);
      if (q.has("hasPassword")) r.hasPassword = toBool(q.get("hasPassword"), r.hasPassword);
      if (q.has("mapName")) r.mapName = safeField(q.get("mapName"), 64);
      if (q.has("mapId")) r.mapId = toInt(q.get("mapId"), r.mapId, 0, 65535);
      r.updatedAt = new Date(n).toISOString();
      r.expiresAt = n + ROOM_TTL_MS;
      r.hostOnline = true;
      items.push({title: bridgeTitle(rid, "OK"), message: id, date: r.updatedAt});
    }
  } else if (action === "remove") {
    const id = String(q.get("id") || "");
    const token = String(q.get("token") || "");
    const r = rooms.get(id);
    const ok = Boolean(r && token && token === r.token);
    if (ok) rooms.delete(id);
    items.push({title: bridgeTitle(rid, ok ? "REMOVED" : "DENIED"), message: id});
  } else {
    items.push({title: bridgeTitle(rid, "ERROR"), message: `unknown_action:${safeField(action,32)}`});
  }

  return send(res, 200, "application/xml; charset=utf-8", notificationXml(items));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/b") {
    url.searchParams.set("action", "boot");
    return bridge(req, res, url);
  }
  if (req.method === "GET" && url.pathname === "/bridge") return bridge(req, res, url);
  if (req.method === "GET" && url.pathname === "/") return sendJson(res, 200, {ok:true, server:SERVER_NAME, game:"Farming Simulator 20 Mobile", mode:"custom-http-master-directory-v2", api:API_PREFIX, bridge:"/bridge", activeRooms:rooms.size, time:nowIso()});
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, {ok:true, server:SERVER_NAME, activeRooms:rooms.size, time:nowIso()});
  if (req.method === "GET" && url.pathname === `${API_PREFIX}/rooms`) return sendJson(res, 200, {ok:true, rooms:[...rooms.values()].map(roomSummary)});
  if (req.method === "GET" && url.pathname === `${API_PREFIX}/info`) return sendJson(res, 200, {ok:true, game:"Farming Simulator 20 Mobile", bridge:true, defaultGamePort:10823, roomTtlMs:ROOM_TTL_MS});
  return sendJson(res, 404, {ok:false,error:"not_found",path:url.pathname});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[FS20] ${SERVER_NAME}`);
  console.log(`[FS20] V2 bridge listening on 0.0.0.0:${PORT}`);
});
