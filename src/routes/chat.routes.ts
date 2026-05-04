import { Router } from "express";
import { handleChat } from "../controllers/chat.controller.js";

const router = Router();

router.post("/chat", handleChat);

export default router;
