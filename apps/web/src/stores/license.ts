import axios from "axios";
import { computed, ref, shallowRef } from "vue";

export interface LicenseStatus {
  isActivated: boolean;
  tier?: "lifetime" | "monthly" | "yearly";
  cardKey?: string;
  expiresAt?: number | null;
  offlineValidUntil?: number;
  machineId: string;
  reason?: string;
}

export const licenseStatus = shallowRef<LicenseStatus | null>(null);
export const isActivated = computed(() => !!licenseStatus.value?.isActivated);
export const licenseLoading = ref(false);
export const licenseError = ref("");
export const guardDialogVisible = ref(false);

export async function fetchLicenseStatus(): Promise<LicenseStatus | null> {
  licenseLoading.value = true;
  licenseError.value = "";
  try {
    const { data } = await axios.get<{ code: number; data: LicenseStatus; message?: string }>("/api/license/status", {
      timeout: 10000,
    });
    if (data.code === 200 && data.data) {
      licenseStatus.value = data.data;
      if (!data.data.isActivated) {
        guardDialogVisible.value = true;
      }
      return data.data;
    }
  } catch (err) {
    const message = axios.isAxiosError(err) ? err.response?.data?.message || err.message : String(err);
    licenseError.value = message;
  } finally {
    licenseLoading.value = false;
  }
  return null;
}

export async function activateLicense(cardKey: string, token?: string): Promise<LicenseStatus> {
  licenseLoading.value = true;
  licenseError.value = "";
  try {
    const { data } = await axios.post<{ code: number; data: LicenseStatus; message?: string }>("/api/license/activate", {
      cardKey: cardKey.trim(),
      token: token?.trim(),
    }, { timeout: 25000 });

    if (data.code === 200 && data.data) {
      licenseStatus.value = data.data;
      guardDialogVisible.value = false;
      return data.data;
    }
    throw new Error(data.message || "激活失败");
  } catch (err) {
    const message = axios.isAxiosError(err) ? err.response?.data?.message || err.message : err instanceof Error ? err.message : "激活失败";
    licenseError.value = message;
    throw new Error(message);
  } finally {
    licenseLoading.value = false;
  }
}

export async function deactivateLicense(forceLocal = false): Promise<void> {
  licenseLoading.value = true;
  licenseError.value = "";
  try {
    const { data } = await axios.post<{ code: number; message?: string }>("/api/license/deactivate", {
      forceLocal,
    }, { timeout: 20000 });

    if (data.code === 200) {
      licenseStatus.value = {
        isActivated: false,
        machineId: licenseStatus.value?.machineId || "",
        reason: "已解绑",
      };
      guardDialogVisible.value = true;
      return;
    }
    throw new Error(data.message || "解绑失败");
  } catch (err) {
    const message = axios.isAxiosError(err) ? err.response?.data?.message || err.message : err instanceof Error ? err.message : "解绑失败";
    licenseError.value = message;
    throw new Error(message);
  } finally {
    licenseLoading.value = false;
  }
}

export async function verifyLicense(): Promise<LicenseStatus | null> {
  try {
    const { data } = await axios.post<{ code: number; data: LicenseStatus; message?: string }>("/api/license/verify", {}, {
      timeout: 15000,
    });
    if (data.code === 200 && data.data) {
      licenseStatus.value = data.data;
      return data.data;
    }
  } catch {
    // 静默续签失败时不阻塞离线使用
  }
  return null;
}
