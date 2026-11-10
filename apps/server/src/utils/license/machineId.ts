import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

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
      // 备用兜底逻辑
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
      // 备用兜底逻辑
    }
  } else if (process.platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, "utf-8").trim();
          if (content) return content;
        } catch {
          // 继续尝试
        }
      }
    }
  }

  // 极端异常环境兜底：使用用户主目录与环境名
  const fallback = `${process.env.USER ?? ""}-${process.env.USERNAME ?? ""}-${process.env.COMPUTERNAME ?? "host"}`;
  return fallback;
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
