<template>
  <el-dialog
    v-model="guardDialogVisible"
    title="DramaAI 软件激活"
    width="min(500px, 92vw)"
    alignCenter
    append-to-body
    :closeOnClickModal="false"
    :closeOnPressEscape="false"
    :showClose="false"
    class="licenseGuardDialog">
    <div class="dialogBody">
      <div class="headerSection">
        <h3 class="appTitle">欢迎使用 DramaAI</h3>
        <p class="subtitle">请输入您购买的软件授权卡密以解锁完整功能</p>
      </div>

      <div class="fieldRow">
        <label class="fieldLabel">本机硬件识别码 (Machine ID)</label>
        <div class="machineIdBox">
          <code>{{ licenseStatus?.machineId || "正在读取…" }}</code>
          <el-button size="small" text @click="copyMachineId">
            {{ copied ? "已复制" : "复制" }}
          </el-button>
        </div>
      </div>

      <div class="fieldRow">
        <label class="fieldLabel">授权卡密 (License Key)</label>
        <el-input
          v-model="inputCardKey"
          placeholder="例如: DRAMA-LIFE-8F9A-2C1D-7E3B"
          clearable
          :disabled="licenseLoading"
          @keyup.enter="handleActivate" />
      </div>

      <el-alert
        v-if="errorMessage"
        :title="errorMessage"
        type="error"
        showIcon
        :closable="false"
        class="errorAlert" />

      <div class="channelTips">
        <span>尚未购买授权？请前往发卡平台或联系官方客服获取卡密。</span>
      </div>
    </div>

    <template #footer>
      <div class="dialogFooter">
        <el-button
          type="primary"
          class="activateBtn"
          :loading="licenseLoading"
          :disabled="!inputCardKey.trim()"
          @click="handleActivate">
          立即激活并进入
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import {
  guardDialogVisible,
  licenseStatus,
  licenseLoading,
  activateLicense,
} from "@/stores/license";

const inputCardKey = ref("");
const copied = ref(false);
const errorMessage = ref("");

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

async function handleActivate() {
  const key = inputCardKey.value.trim();
  if (!key) return;
  errorMessage.value = "";
  try {
    await activateLicense(key);
    ElMessage.success("软件激活成功！欢迎使用 DramaAI");
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "激活失败，请检查卡密输入是否正确";
  }
}
</script>

<style scoped lang="scss">
.licenseGuardDialog {
  .dialogBody {
    display: flex;
    flex-direction: column;
    gap: 16px;

    .headerSection {
      margin-bottom: 4px;

      .appTitle {
        margin: 0 0 6px;
        font-size: 18px;
        font-weight: 600;
        color: var(--el-text-color-primary);
      }

      .subtitle {
        margin: 0;
        font-size: 13px;
        color: var(--el-text-color-secondary);
      }
    }

    .fieldRow {
      display: flex;
      flex-direction: column;
      gap: 6px;

      .fieldLabel {
        font-size: 13px;
        font-weight: 500;
        color: var(--el-text-color-regular);
      }

      .machineIdBox {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        background: var(--el-fill-color-light);
        border: 1px solid var(--el-border-color-lighter);
        border-radius: var(--el-border-radius-base);

        code {
          font-family: monospace;
          font-size: 13px;
          color: var(--el-text-color-primary);
        }
      }
    }

    .errorAlert {
      margin-top: 4px;
    }

    .channelTips {
      margin-top: 4px;
      font-size: 12px;
      color: var(--el-text-color-secondary);
      line-height: 1.5;
    }
  }

  .dialogFooter {
    display: flex;
    justify-content: flex-end;

    .activateBtn {
      min-width: 130px;
    }
  }
}
</style>
