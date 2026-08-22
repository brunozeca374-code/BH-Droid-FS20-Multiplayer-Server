/**
 * BH Droid FS20 Multiplayer Server - REAL V1
 *
 * FS20-only lobby/master-directory foundation, written from the network
 * behavior verified in the supplied Farming Simulator 20 APK + dataS.
 *
 * This service deliberately does NOT emulate GIANTS' encrypted proprietary
 * master-server handshake. It exposes a clean HTTP API that a later FS20
 * client patch can call while keeping the game's normal host/client session
 * code separate.
 */

"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const API_PREFIX = "/api/fs20/v1";
const SERVER_NAME = process.env.SERVER_NAME || "BH Droid FS20 Multiplayer Server";
const ROOM_TTL_MS = Number.parseInt(process.env.ROOM_TTL_MS || "120000", 10);
const CLEANUP_INTERVAL_MS = 30000;
const MAX_BODY_BYTES = 128 * 1024;

const rooms = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function allowCors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,x-fs20-host-token");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload_too_large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function text(value, fallback = "", maxLength = 128) {
  const str = value == null ? fallback : String(value);
  return str.trim().slice(0, maxLength);
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function sourceIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function makeRoomId() {
  // Short enough for mobile UI/logs while remaining random.
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function makeHostToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function roomSummary(room) {
  // Field names intentionally mirror MasterServerConnection:onServerInfo(...)
  return {
    id: room.id,
    name: room.name,
    language: room.language,
    capacity: room.capacity,
    numPlayers: room.numPlayers,
    mapName: room.mapName,
    hasPassword: room.hasPassword,
    allModsAvailable: room.allModsAvailable,
    isLanServer: false,
    isFriendServer: false,
    mapId: room.mapId,
    hostOnline: room.hostOnline,
    updatedAt: room.updatedAt,
  };
}

function roomDetails(room) {
  // Field names intentionally mirror MasterServerConnection:onServerInfoDetails(...)
  return {
    id: room.id,
    ip: room.connectIp,
    port: room.connectPort,
    name: room.name,
    language: room.language,
    capacity: room.capacity,
    numPlayers: room.numPlayers,
    mapName: room.mapName,
    mapId: room.mapId,
    hasPassword: room.hasPassword,
    isLanServer: false,
    modTitles: room.modTitles,
    modHashs: room.modHashs,
    hostOnline: room.hostOnline,
    updatedAt: room.updatedAt,
  };
}

function tokenMatches(req, room, body = {}) {
  const headerToken = text(req.headers["x-fs20-host-token"], "", 256);
  const bodyToken = text(body.hostToken, "", 256);
  const candidate = headerToken || bodyToken;
  if (!candidate || !room.hostToken) return false;

  const a = Buffer.from(candidate);
  const b = Buffer.from(room.hostToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.expiresAt <= now) {
      rooms.delete(id);
    }
  }
}

setInterval(cleanupRooms, CLEANUP_INTERVAL_MS).unref();

const server = http.createServer(async (req, res) => {
  if (allowCors(req, res)) return;

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  try {
    if (req.method === "GET" && pathname === "/") {
      return sendJson(res, 200, {
        ok: true,
        server: SERVER_NAME,
        game: "Farming Simulator 20 Mobile",
        mode: "custom-http-master-directory",
        api: API_PREFIX,
        activeRooms: rooms.size,
        time: nowIso(),
      });
    }

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        server: SERVER_NAME,
        activeRooms: rooms.size,
        time: nowIso(),
      });
    }

    if (req.method === "GET" && pathname === `${API_PREFIX}/info`) {
      return sendJson(res, 200, {
        ok: true,
        game: "Farming Simulator 20 Mobile",
        callbackShape: "MasterServerConnection.lua",
        defaultGamePort: 10823,
        roomTtlMs: ROOM_TTL_MS,
        note: "HTTP lobby only. Direct Internet join still requires a reachable game endpoint or a later relay.",
      });
    }

    // List rooms. Filters are optional and deliberately simple for the first client patch.
    if (req.method === "GET" && pathname === `${API_PREFIX}/rooms`) {
      cleanupRooms();

      const mapId = requestUrl.searchParams.get("mapId");
      const language = requestUrl.searchParams.get("language");
      const name = requestUrl.searchParams.get("name");

      let list = [...rooms.values()].filter((room) => room.hostOnline);

      if (mapId != null && mapId !== "") {
        list = list.filter((room) => String(room.mapId) === String(mapId));
      }
      if (language != null && language !== "") {
        list = list.filter((room) => String(room.language) === String(language));
      }
      if (name != null && name.trim() !== "") {
        const needle = name.trim().toLowerCase();
        list = list.filter((room) => room.name.toLowerCase().includes(needle));
      }

      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      return sendJson(res, 200, {
        ok: true,
        numServers: list.length,
        totalNumServers: rooms.size,
        servers: list.map(roomSummary),
      });
    }

    // Register a game host.
    if (req.method === "POST" && pathname === `${API_PREFIX}/rooms/register`) {
      const body = await readJson(req);
      const id = makeRoomId();
      const hostToken = makeHostToken();
      const timestamp = Date.now();

      const connectIp = text(
        body.connectIp,
        sourceIp(req),
        255
      );

      const room = {
        id,
        hostToken,
        name: text(body.name, "FS20 Game", 64),
        language: integer(body.language, 0, 0, 255),
        capacity: integer(body.capacity, 2, 1, 32),
        numPlayers: integer(body.numPlayers, 1, 0, 32),
        mapName: text(body.mapName, "Unknown", 96),
        mapId: integer(body.mapId, 0, 0, 65535),
        hasPassword: boolean(body.hasPassword, false),
        allModsAvailable: boolean(body.allModsAvailable, true),
        allowOnlyFriends: boolean(body.allowOnlyFriends, false),
        connectIp,
        connectPort: integer(body.connectPort, 10823, 1, 65535),
        modTitles: Array.isArray(body.modTitles) ? body.modTitles.map(v => text(v, "", 128)).slice(0, 128) : [],
        modHashs: Array.isArray(body.modHashs) ? body.modHashs.map(v => text(v, "", 256)).slice(0, 128) : [],
        hostOnline: true,
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
        expiresAt: timestamp + ROOM_TTL_MS,
      };

      rooms.set(id, room);

      return sendJson(res, 201, {
        ok: true,
        hostToken,
        heartbeatSeconds: Math.max(10, Math.floor(ROOM_TTL_MS / 3000)),
        room: roomDetails(room),
      });
    }

    const detailMatch = pathname.match(new RegExp(`^${API_PREFIX}/rooms/([A-Za-z0-9_-]+)$`));
    if (req.method === "GET" && detailMatch) {
      cleanupRooms();
      const id = detailMatch[1].toUpperCase();
      const room = rooms.get(id);

      if (!room) {
        return sendJson(res, 404, { ok: false, error: "room_not_found" });
      }

      return sendJson(res, 200, {
        ok: true,
        room: roomDetails(room),
      });
    }

    const heartbeatMatch = pathname.match(new RegExp(`^${API_PREFIX}/rooms/([A-Za-z0-9_-]+)/heartbeat$`));
    if (req.method === "POST" && heartbeatMatch) {
      const id = heartbeatMatch[1].toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        return sendJson(res, 404, { ok: false, error: "room_not_found" });
      }

      const body = await readJson(req);
      if (!tokenMatches(req, room, body)) {
        return sendJson(res, 403, { ok: false, error: "invalid_host_token" });
      }

      const timestamp = Date.now();
      room.numPlayers = integer(body.numPlayers, room.numPlayers, 0, room.capacity);
      room.name = text(body.name, room.name, 64);
      room.hasPassword = boolean(body.hasPassword, room.hasPassword);
      room.connectIp = text(body.connectIp, room.connectIp, 255);
      room.connectPort = integer(body.connectPort, room.connectPort, 1, 65535);
      room.hostOnline = true;
      room.updatedAt = new Date(timestamp).toISOString();
      room.expiresAt = timestamp + ROOM_TTL_MS;

      return sendJson(res, 200, {
        ok: true,
        room: roomDetails(room),
      });
    }

    const removeMatch = pathname.match(new RegExp(`^${API_PREFIX}/rooms/([A-Za-z0-9_-]+)$`));
    if (req.method === "DELETE" && removeMatch) {
      const id = removeMatch[1].toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        return sendJson(res, 404, { ok: false, error: "room_not_found" });
      }

      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }

      if (!tokenMatches(req, room, body)) {
        return sendJson(res, 403, { ok: false, error: "invalid_host_token" });
      }

      rooms.delete(id);
      return sendJson(res, 200, { ok: true, removed: id });
    }

    return sendJson(res, 404, {
      ok: false,
      error: "not_found",
      path: pathname,
    });
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    console.error("[FS20]", error);
    return sendJson(res, statusCode, {
      ok: false,
      error: statusCode === 500 ? "internal_server_error" : error.message,
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[FS20] ${SERVER_NAME}`);
  console.log(`[FS20] HTTP API listening on 0.0.0.0:${PORT}`);
  console.log(`[FS20] API prefix: ${API_PREFIX}`);
});
