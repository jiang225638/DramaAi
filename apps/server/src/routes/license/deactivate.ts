import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";

const router = Router();
const defaultLicenseServer = process.env.DRAMAAI_LICENSE_SERVER || "https://license.dramaai.top";

export default router.post(
  "/",
  validateFields({
    serverUrl: z.string().url().optional(),
    forceLocal: z.boolean().optional(),
  }),
  async (req, res) => {
    const stored = u.license.readStoredLicense();
    if (!stored || !stored.payload.cardKey) {
      u.license.clearStoredLicense();
      return res.json(success({ message: "本地已处于未激活状态" }));
    }

    const forceLocal = req.body.forceLocal === true;
    if (forceLocal) {
      u.license.clearStoredLicense();
      return res.json(success({ message: "已清除本地激活信息" }));
    }

    const serverUrl = (typeof req.body.serverUrl === "string" && req.body.serverUrl.trim()) || defaultLicenseServer;
    const machineId = u.license.getMachineId();

    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/license/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey: stored.payload.cardKey,
          machineId,
        }),
      });

      const result = await response.json().catch(() => ({})) as {
        code?: number;
        message?: string;
      };

      if (!response.ok || (result.code !== 200 && response.status !== 404)) {
        return res.status(response.status || 400).json(error(result.message || "解绑失败，请重试"));
      }

      u.license.clearStoredLicense();
      return res.json(success({ message: "解绑成功，设备名额已释放" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "连接解绑服务器失败";
      return res.status(502).json(error(`解绑失败: ${message}`));
    }
  },
);
