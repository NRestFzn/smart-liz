import "dotenv/config";
import http from "node:http";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import chatRoutes from "./routes/chat.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { handleWsConnection } from "./controllers/wsChat.controller.js";
import logger from "./lib/logger.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const TTS_SERVICE_URL = (process.env.TTS_SERVICE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const WS_PATH = process.env.WS_PATH ?? "/ws";

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use(
  "/api/v1",
  rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/audio/:filename", async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!/^liz-[A-Za-z0-9-]+\.mp3$/.test(filename)) {
      res.status(400).json({ error: "Invalid audio filename." });
      return;
    }

    const upstream = await fetch(`${TTS_SERVICE_URL}/audio/${encodeURIComponent(filename)}`);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "Audio file not found." });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
    const contentLength = upstream.headers.get("content-length");
    const audio = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.send(audio);
  } catch (err) {
    next(err);
  }
});

app.use("/api/v1", chatRoutes);

app.use(errorHandler);

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

wss.on("connection", (socket, req) => {
  logger.info({ remote: req.socket.remoteAddress, path: WS_PATH }, "WS client connected");
  handleWsConnection(socket);

  socket.on("close", (code, reason) => {
    logger.info({ code, reason: reason.toString() }, "WS client disconnected");
  });
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT, ws_path: WS_PATH }, "Server started");
});
