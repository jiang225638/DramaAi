export type LicenseTier = "lifetime" | "monthly" | "yearly";
export type LicenseStatus = "unused" | "active" | "expired" | "banned";

export interface LicenseItem {
  id: number;
  cardKey: string;
  tier: LicenseTier;
  durationDays: number;
  maxDevices: number;
  status: LicenseStatus;
  rawStatus: LicenseStatus;
  firstActivatedAt: number | null;
  expiresAt: number | null;
  note: string | null;
  createdAt: number;
  deviceCount: number;
}

export interface ActivationItem {
  id: number;
  cardKey: string;
  machineId: string;
  deviceName: string | null;
  platform: string | null;
  activatedAt: number;
  lastVerifiedAt: number;
}

export interface LicenseStats {
  total: number;
  unused: number;
  active: number;
  expired: number;
  banned: number;
  totalDevices: number;
}

export interface LicenseListParams {
  page: number;
  limit: number;
  keyword?: string;
  status?: "all" | LicenseStatus;
  tier?: "all" | LicenseTier;
}

export interface LicenseListResult {
  list: LicenseItem[];
  total: number;
  page: number;
  limit: number;
  stats: LicenseStats;
}

export interface LicenseDetailResult {
  license: LicenseItem;
  activations: ActivationItem[];
}

export interface GenerateLicenseParams {
  tier: LicenseTier;
  count: number;
  durationDays: number;
  maxDevices: number;
  note: string;
}

export interface GenerateLicenseResult {
  keys: string[];
  count: number;
  tier: LicenseTier;
}

export interface UpdateLicenseParams {
  cardKey: string;
  action?: "ban" | "unban";
  maxDevices?: number;
  note?: string | null;
  expiresAt?: number | null;
}

export interface AdminCredentials {
  serverUrl: string;
  adminSecret: string;
}

export class AdminApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface ApiEnvelope<T> {
  code: number;
  data: T;
  message: string;
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "");
}

async function requestAdmin<T>(
  credentials: AdminCredentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const baseUrl = normalizeServerUrl(credentials.serverUrl);
  if (!baseUrl) {
    throw new AdminApiError("请输入有效的服务端地址", 400);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${credentials.adminSecret.trim()}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "网络请求失败";
    throw new AdminApiError(`无法连接卡密服务端：${detail}`, 0);
  }

  const json = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !json || json.code !== 200) {
    const message = json?.message || `请求失败（HTTP ${response.status}）`;
    throw new AdminApiError(message, response.status);
  }

  return json.data;
}

export function fetchLicenseList(
  credentials: AdminCredentials,
  params: LicenseListParams,
): Promise<LicenseListResult> {
  const query = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.keyword?.trim()) {
    query.set("keyword", params.keyword.trim());
  }
  if (params.status && params.status !== "all") {
    query.set("status", params.status);
  }
  if (params.tier && params.tier !== "all") {
    query.set("tier", params.tier);
  }

  return requestAdmin<LicenseListResult>(credentials, `/admin/license/list?${query.toString()}`);
}

export function fetchLicenseDetail(
  credentials: AdminCredentials,
  cardKey: string,
): Promise<LicenseDetailResult> {
  const query = new URLSearchParams({ cardKey });
  return requestAdmin<LicenseDetailResult>(credentials, `/admin/license/detail?${query.toString()}`);
}

export function generateLicenses(
  credentials: AdminCredentials,
  params: GenerateLicenseParams,
): Promise<GenerateLicenseResult> {
  return requestAdmin<GenerateLicenseResult>(credentials, "/admin/license/generate", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateLicense(
  credentials: AdminCredentials,
  params: UpdateLicenseParams,
): Promise<LicenseItem> {
  return requestAdmin<LicenseItem>(credentials, "/admin/license/update", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function unbindLicenseDevice(
  credentials: AdminCredentials,
  cardKey: string,
  machineId: string,
): Promise<null> {
  return requestAdmin<null>(credentials, "/admin/license/unbindDevice", {
    method: "POST",
    body: JSON.stringify({ cardKey, machineId }),
  });
}

export function resetLicenseBindings(
  credentials: AdminCredentials,
  cardKey: string,
): Promise<null> {
  return requestAdmin<null>(credentials, "/admin/license/reset", {
    method: "POST",
    body: JSON.stringify({ cardKey }),
  });
}
