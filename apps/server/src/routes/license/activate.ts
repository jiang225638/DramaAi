import { Router } from "express";
import { z } from "zod";
import os from "node:os";
import u from "@/utils";
import type { LicenseTokenPayload } from "@/utils/license";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";

const router = Router();
const defaultLicenseServer = process.env.DRAMAAI_LICENSE_SERVER || "https://license.dramaai.top";

export default router.post(
  "/",
  validateFields({
    cardKey: z.string().optional(),
    token: z.string().optional(),
    serverUrl: z.string().url().optional(),
  }),
  async (req, res) => {
    const cardKey = typeof req.body.cardKey === "string" ? req.body.cardKey.trim() : "";
    const directToken = typeof req.body.token === "string" ? req.body.token.trim() : "";
    const serverUrl = (typeof req.body.serverUrl === "string" && req.body.serverUrl.trim()) || defaultLicenseServer;
    const machineId = u.license.getMachineId();

    if (directToken) {
      const verification = u.license.verifyToken(directToken, machineId);
      if (!verification.valid || !verification.payload) {
        return res.status(400).json(error(verification.reason || "离线凭证无效"));
      }
      u.license.saveStoredLicense(directToken, verification.payload);
      return res.json(success({
        isActivated: true,
        tier: verification.payload.tier,
        cardKey: verification.payload.cardKey,
        expiresAt: verification.payload.licenseExpiresAt,
        offlineValidUntil: verification.payload.offlineValidUntil,
        machineId,
      }));
    }

    if (!cardKey) {
      return res.status(400).json(error("请提供卡密进行激活"));
    }

    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/license/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey,
          machineId,
          deviceName: os.hostname(),
          platform: process.platform,
        }),
      });

      const result = await response.json().catch(() => ({})) as {
        code?: number;
        data?: { token?: string; payload?: LicenseTokenPayload };
        message?: string;
      };

      if (!response.ok || result.code !== 200 || !result.data?.token || !result.data.payload) {
        return res.status(response.status || 400).json(error(result.message || "激活失败，请检查卡密"));
      }

      u.license.saveStoredLicense(result.data.token, result.data.payload);

      return res.json(success({
        isActivated: true,
        tier: result.data.payload.tier,
        cardKey: result.data.payload.cardKey,
        expiresAt: result.data.payload.licenseExpiresAt,
        offlineValidUntil: result.data.payload.offlineValidUntil,
        machineId,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "连接激活服务器失败，请检查网络设置";
      return res.status(502).json(error(`激活服务器连接失败: ${message}`));
    }
  },
);
