import type { Request, Response, NextFunction } from "express";
import { getLicenseStatus } from "./verifier";

// 仅拦截核心 AI 生成、对话与合成接口，放行初始化、设置读取及模型列表查询接口
const protectedPrefixes = [
  "/api/ai/generate",
  "/api/ai/media/generate",
  "/api/agent/create",
  "/api/agent/message",
  "/api/singleAgent/create",
  "/api/singleAgent/run",
  "/api/ffmpeg",
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
