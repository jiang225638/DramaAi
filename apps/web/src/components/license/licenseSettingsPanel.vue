<template>
  <div class="licenseSettingsPanel">
    <section class="settingSection" aria-labelledby="licenseInfoTitle">
      <h3 id="licenseInfoTitle">软件授权与激活</h3>
      <p class="description">DramaAI 采用独立卡密买断/周期授权，数据与算力 100% 留在本地。</p>
    </section>

    <div class="cardInfoBox">
      <div class="infoRow">
        <span class="label">当前授权状态</span>
        <span class="value">
          <el-tag :type="licenseStatus?.isActivated ? 'success' : 'danger'" effect="light">
            {{ licenseStatus?.isActivated ? '已激活' : '未激活' }}
          </el-tag>
        </span>
      </div>

      <div class="infoRow">
        <span class="label">授权版本</span>
        <span class="value fontBold">
          {{ tierLabel }}
        </span>
      </div>

      <div class="infoRow">
        <span class="label">绑定卡密</span>
        <span class="value">
          <code>{{ maskedCardKey }}</code>
        </span>
      </div>

      <div class="infoRow">
        <span class="label">到期时间</span>
        <span class="value">
          {{ expireTimeLabel }}
        </span>
      </div>

      <div class="infoRow">
        <span class="label">本机硬件码</span>
        <div class="machineRow">
          <code>{{ licenseStatus?.machineId || "正在读取…" }}</code>
          <el-button size="small" text @click="copyMachineId">
            {{ copied ? "已复制" : "复制" }}
          </el-button>
        </div>
      </div>
    </div>

    <div class="actionsSection">
      <el-button
        :loading="licenseLoading"
        @click="handleRefresh">
        刷新授权状态
      </el-button>
      <el-popconfirm
        title="确定要解绑本机吗？解绑后将释放设备名额，本机需要重新输入卡密才能使用。"
        confirmButtonText="确定解绑"
        cancelButtonText="取消"
        @confirm="handleDeactivate">
        <template #reference>
          <el-button
            type="danger"
            plain
            :loading="licenseLoading"
            :disabled="!licenseStatus?.isActivated">
            解绑当前电脑
          </el-button>
        </template>
      </el-popconfirm>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  licenseStatus,
  licenseLoading,
  verifyLicense,
  deactivateLicense,
} from "@/stores/license";

const copied = ref(false);

const tierLabel = computed(() => {
  if (!licenseStatus.value?.isActivated) return "未授权";
  const tier = licenseStatus.value.tier;
  if (tier === "lifetime") return "终身买断版 (Lifetime)";
  if (tier === "yearly") return "年度专业版 (Yearly)";
  if (tier === "monthly") return "月度体验版 (Monthly)";
  return "标准版";
});

const maskedCardKey = computed(() => {
  const key = licenseStatus.value?.cardKey;
  if (!key) return "无";
  if (key.length <= 12) return key;
  return `${key.slice(0, 10)}****${key.slice(-4)}`;
});

const expireTimeLabel = computed(() => {
  if (!licenseStatus.value?.isActivated) return "—";
  if (licenseStatus.value.tier === "lifetime" || licenseStatus.value.expiresAt === null) {
    return "永久有效";
  }
  const exp = licenseStatus.value.expiresAt;
  if (!exp) return "永久有效";
  return new Date(exp).toLocaleString();
});

function copyMachineId() {
  const id = licenseStatus.value?.machineId;
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => {
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
    ElMessage.success("已复制本机机器码");
  });
}

async function handleRefresh() {
  const res = await verifyLicense();
  if (res?.isActivated) {
    ElMessage.success("授权状态刷新成功");
  } else {
    ElMessage.warning(res?.reason || "刷新失败，请检查网络连接");
  }
}

async function handleDeactivate() {
  try {
    await deactivateLicense();
    ElMessage.success("解绑成功，当前电脑已恢复未激活状态");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "解绑失败");
  }
}
</script>

<style scoped lang="scss">
.licenseSettingsPanel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;

  .settingSection {
    h3 {
      margin: 0 0 6px;
      font-size: 16px;
      font-weight: 600;
      color: var(--el-text-color-primary);
    }

    .description {
      margin: 0;
      font-size: 13px;
      color: var(--el-text-color-secondary);
      line-height: 1.5;
    }
  }

  .cardInfoBox {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);

    .infoRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-size: 13px;

      .label {
        color: var(--el-text-color-secondary);
        min-width: 90px;
      }

      .value {
        color: var(--el-text-color-primary);

        &.fontBold {
          font-weight: 600;
        }

        code {
          font-family: monospace;
          background: var(--el-fill-color);
          padding: 2px 6px;
          border-radius: 4px;
        }
      }

      .machineRow {
        display: flex;
        align-items: center;
        gap: 8px;

        code {
          font-family: monospace;
          background: var(--el-fill-color);
          padding: 2px 6px;
          border-radius: 4px;
        }
      }
    }
  }

  .actionsSection {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
}
</style>
