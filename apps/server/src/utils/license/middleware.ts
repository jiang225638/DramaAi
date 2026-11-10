import type { Request, Response, NextFunction } from "express";
import { getLicenseStatus } from "./verifier";

// 拦截需要授权的敏感/核心创作路径
const protectedPrefixes = [
  "/api/ai",
  "/api/media/generate",
  "/api/media/debug",
  "/api/singleAgent",
  "/api/providers/models",
];

export function licenseGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  const isProtected = protectedPrefixes.some(prefix => path.startsWith(prefix));

  if (!isProtected) {
    return next();
  }

  const status = getLicenseStatus();
  if (status.isActivated) {
    return next();
  }

  res.status(402).json({
    code: 402,
    data: {
      needActivation: true,
      machineId: status.machineId,
      reason: status.reason,
    },
    message: status.reason || "软件尚未激活或授权已失效，请先激活",
  });
}
