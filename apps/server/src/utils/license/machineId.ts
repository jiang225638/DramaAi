import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeAtomicSync } from "@toonflow/file";

let cachedMachineId: string | null = null;

function getRawPlatformId(): string {
  if (process.platform === "win32") {
    try {
      const output = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      });
      const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {
      // 继续尝试兜底
    }
  } else if (process.platform === "darwin") {
    try {
      const output = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {
      // 继续尝试兜底
    }
  } else if (process.platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, "utf-8").trim();
          if (content) return content;
        } catch {
          // 沙盒环境下无权限读取系统 machine-id，转入持久化 UUID
        }
      }
    }
  }

  // Android 等沙盒环境无法读取底层硬件 ID 时，在应用私有数据目录持久化唯一设备 UUID
  try {
    const dataDir = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
    mkdirSync(dataDir, { recursive: true });
    const uuidFile = resolve(dataDir, ".device_uuid");
    if (existsSync(uuidFile)) {
      const saved = readFileSync(uuidFile, "utf-8").trim();
      if (saved) return saved;
    }
    const generated = randomUUID();
    writeAtomicSync(uuidFile, generated);
    return generated;
  } catch {
    return `${process.env.USER ?? ""}-${process.env.USERNAME ?? ""}-${process.env.COMPUTERNAME ?? "host"}`;
  }
}

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const rawId = getRawPlatformId();
  cachedMachineId = createHash("sha256")
    .update(`dramaai-salt:${rawId.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return cachedMachineId;
}
