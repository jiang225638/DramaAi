<template>
  <el-drawer
    :modelValue="visible"
    title="卡密详情与设备售后"
    size="min(580px, 96vw)"
    destroyOnClose
    @update:modelValue="handleVisibleChange">
    <div v-loading="loading" class="drawerContent">
      <template v-if="license">
        <section class="sectionBox">
          <div class="keyHeader">
            <code class="cardKeyText">{{ license.cardKey }}</code>
            <el-button size="small" text @click="handleCopyKey(license.cardKey)">
              <template #icon><icon-copy :size="15" /></template>
              复制卡密
            </el-button>
          </div>

          <div class="metaTags">
            <el-tag :type="tierTagType(license.tier)" effect="light">{{ tierLabel(license.tier) }}</el-tag>
            <el-tag :type="statusTagType(license.status)" effect="dark">{{ statusLabel(license.status) }}</el-tag>
            <span class="metaText">创建于 {{ formatDateTime(license.createdAt) }}</span>
          </div>

          <div class="metaGrid">
            <div class="metaItem">
              <span class="metaLabel">首次激活时间</span>
              <span class="metaValue">{{ formatDateTime(license.firstActivatedAt) }}</span>
            </div>
            <div class="metaItem">
              <span class="metaLabel">有效期 / 到期时间</span>
              <span class="metaValue">{{ formatValidity(license) }}</span>
            </div>
          </div>
        </section>

        <section class="sectionBox">
          <h4 class="sectionTitle">参数调整与状态控制</h4>
          <el-form labelWidth="110px" class="editForm">
            <el-form-item label="设备上限">
              <el-input-number v-model="editForm.maxDevices" :min="1" :max="100" />
            </el-form-item>

            <el-form-item v-if="license.tier !== 'lifetime' && license.firstActivatedAt !== null" label="到期时间">
              <div class="expiryRow">
                <el-date-picker
                  v-model="editForm.expiresAt"
                  type="datetime"
                  valueFormat="x"
                  placeholder="选择到期时间" />
                <div class="quickExtend">
                  <el-button size="small" @click="extendDays(30)">+30 天</el-button>
                  <el-button size="small" @click="extendDays(365)">+365 天</el-button>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="批次 / 备注">
              <el-input v-model="editForm.note" maxlength="200" placeholder="输入备注信息" clearable />
            </el-form-item>

            <el-form-item>
              <div class="actionRow">
                <el-button type="primary" :loading="saving" @click="handleSave">保存修改</el-button>
                <el-popconfirm
                  v-if="license.status !== 'banned'"
                  title="封禁后该卡密将无法激活和联网续签，确定封禁吗？"
                  confirmButtonText="确定封禁"
                  cancelButtonText="取消"
                  @confirm="handleToggleBan('ban')">
                  <template #reference>
                    <el-button type="danger" plain :loading="saving">封禁此卡密</el-button>
                  </template>
                </el-popconfirm>
                <el-button v-else type="success" plain :loading="saving" @click="handleToggleBan('unban')">
                  解除封禁
                </el-button>
              </div>
            </el-form-item>
          </el-form>
        </section>

        <section class="sectionBox">
          <div class="deviceHeader">
            <h4 class="sectionTitle">已绑定设备 ({{ activations.length }} / {{ license.maxDevices }})</h4>
            <el-popconfirm
              v-if="activations.length > 0"
              title="清空后所有绑定该卡密的电脑需重新输入卡密激活，确定清空吗？"
              confirmButtonText="确定清空"
              cancelButtonText="取消"
              @confirm="handleResetAll">
              <template #reference>
                <el-button type="warning" size="small" plain :loading="saving">清空全部绑定</el-button>
              </template>
            </el-popconfirm>
          </div>

          <el-empty v-if="!activations.length" description="暂无设备绑定记录" :imageSize="64" />

          <div v-else class="deviceList">
            <div v-for="device in activations" :key="device.id" class="deviceCard">
              <div class="deviceTop">
                <div class="deviceName">
                  <icon-device-desktop :size="16" />
                  <strong>{{ device.deviceName || "未命名设备" }}</strong>
                  <el-tag size="small" effect="plain">{{ device.platform || "unknown" }}</el-tag>
                </div>
                <el-popconfirm
                  title="解绑该设备后可释放 1 个激活名额，确定解绑吗？"
                  confirmButtonText="确定解绑"
                  cancelButtonText="取消"
                  @confirm="handleUnbindDevice(device.machineId)">
                  <template #reference>
                    <el-button type="danger" size="small" text :loading="saving">解绑</el-button>
                  </template>
                </el-popconfirm>
              </div>

              <div class="deviceMeta">
                <div class="machineLine">
                  <span>硬件码：</span>
                  <code>{{ device.machineId }}</code>
                  <el-button size="small" text @click="handleCopyKey(device.machineId)">复制</el-button>
                </div>
                <div class="timeLine">
                  <span>激活：{{ formatDateTime(device.activatedAt) }}</span>
                  <span>最近续签：{{ formatDateTime(device.lastVerifiedAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { IconCopy, IconDeviceDesktop } from "@tabler/icons-vue";
import {
  fetchLicenseDetail,
  resetLicenseBindings,
  unbindLicenseDevice,
  updateLicense,
  type ActivationItem,
  type LicenseItem,
} from "@/api/licenseAdmin";
import { adminCredentials, handleSessionError } from "@/stores/adminSession";
import {
  copyText,
  formatDateTime,
  formatValidity,
  statusLabel,
  statusTagType,
  tierLabel,
  tierTagType,
} from "@/utils/format";

const props = defineProps<{
  visible: boolean;
  cardKey: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  updated: [];
}>();

const loading = ref(false);
const saving = ref(false);
const license = ref<LicenseItem | null>(null);
const activations = ref<ActivationItem[]>([]);

const editForm = reactive<{
  maxDevices: number;
  note: string;
  expiresAt: string | null;
}>({
  maxDevices: 1,
  note: "",
  expiresAt: null,
});

watch(
  () => [props.visible, props.cardKey] as const,
  ([open, key]) => {
    if (open && key) {
      void loadDetail(key);
    }
  },
);

function handleVisibleChange(value: boolean) {
  emit("update:visible", value);
}

async function loadDetail(cardKey: string) {
  loading.value = true;
  try {
    const data = await fetchLicenseDetail(adminCredentials.value, cardKey);
    license.value = data.license;
    activations.value = data.activations;
    editForm.maxDevices = data.license.maxDevices;
    editForm.note = data.license.note || "";
    editForm.expiresAt = data.license.expiresAt ? String(data.license.expiresAt) : null;
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "加载卡密详情失败");
    }
  } finally {
    loading.value = false;
  }
}

function extendDays(days: number) {
  const current = editForm.expiresAt ? Number(editForm.expiresAt) : 0;
  const base = current > Date.now() ? current : Date.now();
  editForm.expiresAt = String(base + days * 86400_000);
}

async function handleSave() {
  if (!license.value) return;
  saving.value = true;
  try {
    await updateLicense(adminCredentials.value, {
      cardKey: license.value.cardKey,
      maxDevices: editForm.maxDevices,
      note: editForm.note.trim() || null,
      ...(license.value.tier !== "lifetime" && license.value.firstActivatedAt !== null
        ? { expiresAt: editForm.expiresAt ? Number(editForm.expiresAt) : null }
        : {}),
    });
    ElMessage.success("卡密信息已更新");
    await loadDetail(license.value.cardKey);
    emit("updated");
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "保存失败");
    }
  } finally {
    saving.value = false;
  }
}

async function handleToggleBan(action: "ban" | "unban") {
  if (!license.value) return;
  saving.value = true;
  try {
    await updateLicense(adminCredentials.value, {
      cardKey: license.value.cardKey,
      action,
    });
    ElMessage.success(action === "ban" ? "已封禁该卡密" : "已解除封禁");
    await loadDetail(license.value.cardKey);
    emit("updated");
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "状态修改失败");
    }
  } finally {
    saving.value = false;
  }
}

async function handleUnbindDevice(machineId: string) {
  if (!license.value) return;
  saving.value = true;
  try {
    await unbindLicenseDevice(adminCredentials.value, license.value.cardKey, machineId);
    ElMessage.success("已解绑该设备");
    await loadDetail(license.value.cardKey);
    emit("updated");
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "解绑设备失败");
    }
  } finally {
    saving.value = false;
  }
}

async function handleResetAll() {
  if (!license.value) return;
  saving.value = true;
  try {
    await resetLicenseBindings(adminCredentials.value, license.value.cardKey);
    ElMessage.success("已清空全部设备绑定");
    await loadDetail(license.value.cardKey);
    emit("updated");
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "清空绑定失败");
    }
  } finally {
    saving.value = false;
  }
}

async function handleCopyKey(text: string) {
  try {
    await copyText(text);
    ElMessage.success("已复制到剪贴板");
  } catch {
    ElMessage.error("复制失败");
  }
}
</script>

<style scoped lang="scss">
.drawerContent {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 240px;

  .sectionBox {
    padding: 16px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 10px;

    .sectionTitle {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
      color: #111827;
    }

    .keyHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;

      .cardKeyText {
        font-size: 15px;
        font-weight: 700;
        color: #111827;
        word-break: break-all;
      }
    }

    .metaTags {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;

      .metaText {
        font-size: 12px;
        color: #6b7280;
      }
    }

    .metaGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;

      .metaItem {
        display: flex;
        flex-direction: column;
        gap: 4px;

        .metaLabel {
          font-size: 12px;
          color: #6b7280;
        }

        .metaValue {
          font-size: 13px;
          color: #111827;
        }
      }
    }

    .editForm {
      .expiryRow {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;

        .quickExtend {
          display: flex;
          gap: 8px;
        }
      }

      .actionRow {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
    }

    .deviceHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;

      .sectionTitle {
        margin: 0;
      }
    }

    .deviceList {
      display: flex;
      flex-direction: column;
      gap: 10px;

      .deviceCard {
        padding: 12px;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;

        .deviceTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;

          .deviceName {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #111827;
            font-size: 13px;
          }
        }

        .deviceMeta {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          color: #6b7280;

          .machineLine {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;

            code {
              color: #374151;
              background: #f3f4f6;
              padding: 1px 6px;
              border-radius: 4px;
            }
          }

          .timeLine {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
          }
        }
      }
    }
  }
}
</style>
