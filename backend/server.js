import { createServer } from "node:http";
import { createReadStream, existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const videosDir = path.join(__dirname, "videos");
const PORT = Number(process.env.PORT || 3001);

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogg": "video/ogg",
  ".mov": "video/quicktime"
};

const clients = new Map();
const rooms = new Map();

function normalizeName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 32);
}

function sendJson(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, code, message) {
  sendJson(ws, { type: "room_error", code, message });
}

function getMovieUrl(movieId) {
  return `/videos/${encodeURIComponent(movieId)}`;
}

function getMovieName(movieId) {
  return path.parse(movieId).name;
}

async function handleMovies(req, res) {
  try {
    const entries = await fsPromises.readdir(videosDir, { withFileTypes: true });
    const movies = entries
      .filter((entry) => entry.isFile() && MIME_TYPES[path.extname(entry.name).toLowerCase()])
      .map((entry) => ({
        id: entry.name,
        name: path.parse(entry.name).name,
        url: getMovieUrl(entry.name)
      }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(movies));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read videos directory" }));
  }
}

function resolveVideoPath(filename) {
  const decoded = decodeURIComponent(filename);
  const resolved = path.resolve(videosDir, decoded);

  if (!resolved.startsWith(path.resolve(videosDir))) {
    return null;
  }

  return resolved;
}

async function handleVideo(req, res, filename) {
  const filePath = resolveVideoPath(filename);

  if (!filePath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid file path" }));
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  const stats = await fsPromises.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  const rangeHeader = req.headers.range;

  if (rangeHeader?.startsWith("bytes=")) {
    const [startRaw, endRaw] = rangeHeader.replace("bytes=", "").split("-");
    const start = Number.parseInt(startRaw, 10);
    const end = endRaw ? Number.parseInt(endRaw, 10) : stats.size - 1;

    if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start >= 0 && end < stats.size) {
      res.writeHead(206, {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Content-Length": end - start + 1
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": stats.size
  });
  createReadStream(filePath).pipe(res);
}

function broadcastToRoom(roomId, payload, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const participantId of room.participants) {
    if (participantId === excludeClientId) {
      continue;
    }

    const client = clients.get(participantId);
    if (client) {
      sendJson(client.ws, payload);
    }
  }
}

function notifyParticipantCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  broadcastToRoom(roomId, {
    type: "participant_update",
    participantCount: room.participants.size
  });
}

function getSenderLabel(client) {
  return client.userName || `User ${client.clientId.slice(0, 6)}`;
}

function leaveCurrentRoom(clientId) {
  const client = clients.get(clientId);
  if (!client?.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }

  room.participants.delete(clientId);
  client.roomId = null;

  if (room.participants.size === 0) {
    rooms.delete(room.roomId);
    return;
  }

  if (room.hostClientId === clientId) {
    room.hostClientId = [...room.participants][0];
  }

  notifyParticipantCount(room.roomId);
}

function createRoom(movieId, hostClientId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const roomId = crypto.randomUUID();
    if (rooms.has(roomId)) {
      continue;
    }

    const room = {
      roomId,
      movieId,
      movieName: getMovieName(movieId),
      movieUrl: getMovieUrl(movieId),
      hostClientId,
      participants: new Set([hostClientId]),
      playbackState: {
        timestamp: 0,
        status: "paused",
        lastUpdatedAt: Date.now()
      },
      createdAt: Date.now()
    };

    rooms.set(roomId, room);
    clients.get(hostClientId).roomId = roomId;
    return room;
  }

  return null;
}

function joinRoom(clientId, roomId) {
  const room = rooms.get(roomId);
  const client = clients.get(clientId);

  if (!room || !client) {
    return null;
  }

  leaveCurrentRoom(clientId);
  room.participants.add(clientId);
  client.roomId = roomId;
  notifyParticipantCount(roomId);
  return room;
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    movieId: room.movieId,
    movieName: room.movieName,
    movieUrl: room.movieUrl,
    playbackState: room.playbackState,
    participantCount: room.participants.size
  };
}

function handleWsMessage(clientId, rawMessage) {
  let message;

  try {
    message = JSON.parse(rawMessage.toString());
  } catch (error) {
    console.error("Invalid JSON message", error);
    return;
  }

  if (!message?.type) {
    console.warn("Missing message type");
    return;
  }

  const client = clients.get(clientId);
  if (!client) {
    return;
  }

  switch (message.type) {
    case "create_room": {
      const userName = normalizeName(message.userName);

      if (typeof message.movieId !== "string" || !message.movieId.trim() || !userName) {
        sendError(client.ws, "INVALID_PAYLOAD", "movieId and userName are required");
        return;
      }

      const filePath = resolveVideoPath(message.movieId);
      if (!filePath || !existsSync(filePath) || !MIME_TYPES[path.extname(message.movieId).toLowerCase()]) {
        sendError(client.ws, "INVALID_PAYLOAD", "movieId does not exist");
        return;
      }

      leaveCurrentRoom(clientId);
      client.userName = userName;
      const room = createRoom(message.movieId, clientId);

      if (!room) {
        sendError(client.ws, "ROOM_CREATE_FAILED", "Could not allocate a room");
        return;
      }

      sendJson(client.ws, { type: "room_created", ...serializeRoom(room) });
      return;
    }

    case "join_room": {
      const userName = normalizeName(message.userName);

      if (typeof message.roomId !== "string" || !message.roomId.trim() || !userName) {
        sendError(client.ws, "INVALID_PAYLOAD", "roomId and userName are required");
        return;
      }

      client.userName = userName;
      const room = joinRoom(clientId, message.roomId.trim());
      if (!room) {
        sendError(client.ws, "ROOM_NOT_FOUND", "Room not found");
        return;
      }

      sendJson(client.ws, { type: "room_joined", ...serializeRoom(room) });
      return;
    }

    case "leave_room": {
      leaveCurrentRoom(clientId);
      return;
    }

    case "player_event": {
      const roomId = client.roomId;
      const room = roomId ? rooms.get(roomId) : null;

      if (!room) {
        sendError(client.ws, "NOT_IN_ROOM", "Join a room before syncing playback");
        return;
      }

      if (typeof message.event !== "string" || typeof message.timestamp !== "number") {
        sendError(client.ws, "INVALID_PAYLOAD", "event and timestamp are required");
        return;
      }

      const status = message.event === "play" ? "playing" : message.event === "pause" ? "paused" : room.playbackState.status;

      room.playbackState = {
        timestamp: message.timestamp,
        status,
        lastUpdatedAt: Date.now()
      };

      broadcastToRoom(roomId, {
        type: "player_event",
        event: message.event,
        timestamp: message.timestamp,
        fromClientId: clientId
      }, clientId);
      return;
    }

    case "chat_message": {
      const roomId = client.roomId;
      const room = roomId ? rooms.get(roomId) : null;
      const text = typeof message.text === "string" ? message.text.trim() : "";

      if (!room) {
        sendError(client.ws, "NOT_IN_ROOM", "Join a room before chatting");
        return;
      }

      if (!text) {
        return;
      }

      broadcastToRoom(roomId, {
        type: "chat_message",
        senderId: clientId,
        senderLabel: getSenderLabel(client),
        text,
        receivedAt: Date.now()
      });
      return;
    }

    case "reaction": {
      const roomId = client.roomId;
      const room = roomId ? rooms.get(roomId) : null;
      const emoji = typeof message.emoji === "string" ? message.emoji.trim().slice(0, 8) : "";

      if (!room) {
        sendError(client.ws, "NOT_IN_ROOM", "Join a room before sending reactions");
        return;
      }

      if (!emoji) {
        return;
      }

      broadcastToRoom(roomId, {
        type: "reaction",
        reactionId: crypto.randomUUID(),
        emoji,
        senderId: clientId,
        senderLabel: getSenderLabel(client),
        receivedAt: Date.now()
      });
      return;
    }

    default:
      console.warn("Unknown message type:", message.type);
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/movies") {
    await handleMovies(req, res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/videos/")) {
    const filename = requestUrl.pathname.replace("/videos/", "");
    await handleVideo(req, res, filename);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID();

  clients.set(clientId, {
    clientId,
    ws,
    roomId: null,
    userName: "",
    connectedAt: Date.now()
  });

  sendJson(ws, { type: "connected", clientId });

  ws.on("message", (rawMessage) => {
    handleWsMessage(clientId, rawMessage);
  });

  ws.on("close", () => {
    leaveCurrentRoom(clientId);
    clients.delete(clientId);
  });
});

await fsPromises.mkdir(videosDir, { recursive: true });

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
