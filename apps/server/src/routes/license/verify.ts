import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import type { LicenseTokenPayload } from "@/utils/license";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.post(
  "/",
  validateFields({
    serverUrl: z.string().url().optional(),
  }),
  async (req, res) => {
    const stored = u.license.readStoredLicense();
    if (!stored || !stored.payload.cardKey) {
      return res.status(400).json(error("本地未找到已激活的卡密"));
    }

    const serverUrl = (typeof req.body.serverUrl === "string" && req.body.serverUrl.trim()) || u.license.defaultLicenseServer;
    const machineId = u.license.getMachineId();

    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/license/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey: stored.payload.cardKey,
          machineId,
        }),
      });

      const result = await response.json().catch(() => ({})) as {
        code?: number;
        data?: { token?: string; payload?: LicenseTokenPayload };
        message?: string;
      };

      if (!response.ok || result.code !== 200 || !result.data?.token || !result.data.payload) {
        return res.status(response.status || 400).json(error(result.message || "续签校验失败"));
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
      const message = err instanceof Error ? err.message : "连接验证服务器失败";
      return res.status(502).json(error(`验证服务器连接失败: ${message}`));
    }
  },
);
