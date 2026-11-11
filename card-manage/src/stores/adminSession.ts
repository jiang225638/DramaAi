import { computed, reactive } from "vue";
import { AdminApiError, fetchLicenseList, type AdminCredentials } from "@/api/licenseAdmin";

const defaultServerUrl = "https://license.explorlove.online";
const serverUrlStorageKey = "dramaaiCardManageServerUrl";
const secretStorageKey = "dramaaiCardManageSecret";

function readInitialServerUrl(): string {
  return localStorage.getItem(serverUrlStorageKey) || defaultServerUrl;
}

function readInitialSecret(): string {
  return sessionStorage.getItem(secretStorageKey) || "";
}

export const adminSession = reactive({
  serverUrl: readInitialServerUrl(),
  adminSecret: readInitialSecret(),
  authenticated: false,
  verifying: false,
  authError: "",
});

export const adminCredentials = computed<AdminCredentials>(() => ({
  serverUrl: adminSession.serverUrl,
  adminSecret: adminSession.adminSecret,
}));

export function hasStoredSecret(): boolean {
  return Boolean(adminSession.serverUrl.trim() && adminSession.adminSecret.trim());
}

export async function loginAdmin(serverUrl: string, adminSecret: string): Promise<boolean> {
  const cleanUrl = serverUrl.trim().replace(/\/+$/, "");
  const cleanSecret = adminSecret.trim();
  if (!cleanUrl || !cleanSecret) {
    adminSession.authError = "请填写服务端地址与管理员密钥";
    return false;
  }

  adminSession.verifying = true;
  adminSession.authError = "";
  try {
    await fetchLicenseList(
      { serverUrl: cleanUrl, adminSecret: cleanSecret },
      { page: 1, limit: 1 },
    );
    adminSession.serverUrl = cleanUrl;
    adminSession.adminSecret = cleanSecret;
    adminSession.authenticated = true;
    localStorage.setItem(serverUrlStorageKey, cleanUrl);
    sessionStorage.setItem(secretStorageKey, cleanSecret);
    return true;
  } catch (error) {
    adminSession.authenticated = false;
    adminSession.authError = error instanceof Error ? error.message : "验证失败";
    if (error instanceof AdminApiError && error.status === 401) {
      sessionStorage.removeItem(secretStorageKey);
    }
    return false;
  } finally {
    adminSession.verifying = false;
  }
}

export function handleSessionError(error: unknown): boolean {
  if (error instanceof AdminApiError && error.status === 401) {
    adminSession.authenticated = false;
    adminSession.adminSecret = "";
    adminSession.authError = "管理员密钥无效或已失效，请重新登录";
    sessionStorage.removeItem(secretStorageKey);
    return true;
  }
  return false;
}

export function logoutAdmin(): void {
  adminSession.authenticated = false;
  adminSession.adminSecret = "";
  adminSession.authError = "";
  sessionStorage.removeItem(secretStorageKey);
}
