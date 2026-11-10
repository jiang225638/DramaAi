import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  const status = u.license.getLicenseStatus();
  res.json(success(status));
});
