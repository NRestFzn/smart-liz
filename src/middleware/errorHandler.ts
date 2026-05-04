import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import logger from "../lib/logger.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    logger.warn({ issues: err.issues }, "Validation error");
    res.status(422).json({
      error: "Validation failed",
      details: err.issues,
    });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err }, message);
  res.status(500).json({ error: message });
}
