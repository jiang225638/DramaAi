import type { LicenseItem, LicenseStatus, LicenseTier } from "@/api/licenseAdmin";

export function tierLabel(tier: LicenseTier): string {
  if (tier === "lifetime") return "终身买断";
  if (tier === "yearly") return "年度专业";
  return "月度体验";
}

export function tierTagType(tier: LicenseTier): "warning" | "primary" | "info" {
  if (tier === "lifetime") return "warning";
  if (tier === "yearly") return "primary";
  return "info";
}

export function statusLabel(status: LicenseStatus): string {
  if (status === "unused") return "未使用";
  if (status === "active") return "已激活";
  if (status === "expired") return "已过期";
  return "已封禁";
}

export function statusTagType(status: LicenseStatus): "info" | "success" | "warning" | "danger" {
  if (status === "unused") return "info";
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  return "danger";
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

export function formatValidity(item: LicenseItem): string {
  if (item.tier === "lifetime") return "永久有效";
  if (item.firstActivatedAt === null) {
    return `激活后 ${item.durationDays} 天`;
  }
  return formatDateTime(item.expiresAt);
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function downloadTextFile(fileName: string, content: string, mimeType = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

export function exportLicensesCsv(items: LicenseItem[]): string {
  const header = ["卡密", "档位", "状态", "已绑设备", "设备上限", "有效规则/到期时间", "备注", "创建时间"];
  const rows = items.map((item) => [
    item.cardKey,
    tierLabel(item.tier),
    statusLabel(item.status),
    String(item.deviceCount),
    String(item.maxDevices),
    formatValidity(item),
    item.note || "",
    formatDateTime(item.createdAt),
  ]);
  const lines = [header, ...rows].map((row) => row.map(escapeCsvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
}
