import { existsSync, readFileSync, rmSync, writeAtomicSync } from "@toonflow/file";
import { resolve } from "node:path";
import { verify } from "node:crypto";
import { getMachineId } from "./machineId";

export const ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5JB5U3hB+cbap8k+jBZyhP/9rZe8TvgZoLe35ZPaP08=
-----END PUBLIC KEY-----`;

export interface LicenseTokenPayload {
  v: 1;
  cardKey: string;
  machineId: string;
  tier: "lifetime" | "monthly" | "yearly";
  issuedAt: number;
  licenseExpiresAt: number | null;
  offlineValidUntil: number;
}

export interface StoredLicenseInfo {
  token: string;
  payload: LicenseTokenPayload;
  lastKnownTimestamp: number;
}

export interface LicenseStatusResult {
  isActivated: boolean;
  tier?: "lifetime" | "monthly" | "yearly";
  cardKey?: string;
  expiresAt?: number | null;
  offlineValidUntil?: number;
  machineId: string;
  reason?: string;
}

function getLicenseFilePath(): string {
  const dataDir = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
  return resolve(dataDir, "license.json");
}

export function readStoredLicense(): StoredLicenseInfo | null {
  const path = getLicenseFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as StoredLicenseInfo;
    if (parsed && typeof parsed.token === "string" && parsed.payload) {
      return parsed;
    }
  } catch {
    // 忽略异常 JSON
  }
  return null;
}

export function saveStoredLicense(token: string, payload: LicenseTokenPayload): void {
  const path = getLicenseFilePath();
  const info: StoredLicenseInfo = {
    token,
    payload,
    lastKnownTimestamp: Date.now(),
  };
  writeAtomicSync(path, JSON.stringify(info, null, 2));
}

export function clearStoredLicense(): void {
  const path = getLicenseFilePath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

export function verifyToken(
  token: string,
  machineId: string,
): { valid: boolean; reason?: string; payload?: LicenseTokenPayload } {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { valid: false, reason: "授权凭证格式损坏" };
    }

    const payloadBytes = Buffer.from(parts[0]!, "base64");
    const signatureBytes = Buffer.from(parts[1]!, "base64");

    const isVerified = verify(null, payloadBytes, ED25519_PUBLIC_KEY, signatureBytes);
    if (!isVerified) {
      return { valid: false, reason: "授权签名无效或被篡改" };
    }

    const payload = JSON.parse(payloadBytes.toString("utf-8")) as LicenseTokenPayload;

    if (payload.machineId.toLowerCase() !== machineId.toLowerCase()) {
      return { valid: false, reason: "当前设备与授权绑定设备不一致" };
    }

    const now = Date.now();
    if (payload.licenseExpiresAt !== null && now > payload.licenseExpiresAt) {
      return { valid: false, reason: "卡密授权已过期", payload };
    }

    if (now > payload.offlineValidUntil) {
      return { valid: false, reason: "离线免验证已达上限，请连接网络刷新授权", payload };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "解析授权凭证失败" };
  }
}

export function getLicenseStatus(): LicenseStatusResult {
  const machineId = getMachineId();
  const stored = readStoredLicense();

  if (!stored) {
    return {
      isActivated: false,
      machineId,
      reason: "软件尚未激活",
    };
  }

  const now = Date.now();
  // 防时间回拨（倒拨超过1小时）
  if (stored.lastKnownTimestamp && now < stored.lastKnownTimestamp - 3600_000) {
    return {
      isActivated: false,
      machineId,
      reason: "检测到系统时间发生异常回拨，请修正系统时钟后联网重试",
    };
  }

  const verification = verifyToken(stored.token, machineId);
  if (!verification.valid || !verification.payload) {
    return {
      isActivated: false,
      machineId,
      reason: verification.reason ?? "授权凭证已失效",
    };
  }

  // 正常运行，平滑顺延更新已知时间
  if (now > (stored.lastKnownTimestamp || 0)) {
    stored.lastKnownTimestamp = now;
    const path = getLicenseFilePath();
    try {
      writeAtomicSync(path, JSON.stringify(stored, null, 2));
    } catch {
      // 容错忽略
    }
  }

  return {
    isActivated: true,
    tier: verification.payload.tier,
    cardKey: verification.payload.cardKey,
    expiresAt: verification.payload.licenseExpiresAt,
    offlineValidUntil: verification.payload.offlineValidUntil,
    machineId,
  };
}
