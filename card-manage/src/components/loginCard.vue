<template>
  <div class="loginShell">
    <el-card class="loginCard" shadow="always">
      <div class="brandBlock">
        <div class="brandIcon">
          <icon-key :size="26" />
        </div>
        <div class="brandText">
          <h1>DramaAI 卡密管理平台</h1>
          <p>连接 Cloudflare Worker 卡密节点，进行批量制卡、状态管理与设备售后解绑</p>
        </div>
      </div>

      <el-form labelPosition="top" @submit.prevent="handleSubmit">
        <el-form-item label="卡密服务端地址">
          <el-input
            v-model="form.serverUrl"
            placeholder="https://license.explorlove.online"
            clearable />
        </el-form-item>

        <el-form-item label="管理员密钥 (ADMIN_SECRET)">
          <el-input
            v-model="form.adminSecret"
            type="password"
            placeholder="请输入 Cloudflare Worker ADMIN_SECRET"
            showPassword
            clearable
            @keyup.enter="handleSubmit" />
        </el-form-item>

        <el-alert
          v-if="adminSession.authError"
          :title="adminSession.authError"
          type="error"
          showIcon
          :closable="false"
          class="errorAlert" />

        <el-button
          type="primary"
          class="submitBtn"
          :loading="adminSession.verifying"
          :disabled="!form.serverUrl.trim() || !form.adminSecret.trim()"
          @click="handleSubmit">
          验证并进入管理台
        </el-button>
      </el-form>

      <div class="securityHint">
        密钥仅保存在当前浏览器会话（sessionStorage），关闭标签页后自动清除。
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import { IconKey } from "@tabler/icons-vue";
import { adminSession, loginAdmin } from "@/stores/adminSession";

const emit = defineEmits<{
  loggedIn: [];
}>();

const form = reactive({
  serverUrl: adminSession.serverUrl,
  adminSecret: adminSession.adminSecret,
});

async function handleSubmit() {
  const ok = await loginAdmin(form.serverUrl, form.adminSecret);
  if (ok) {
    emit("loggedIn");
  }
}
</script>

<style scoped lang="scss">
.loginShell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: radial-gradient(circle at top right, #e8f1ff 0%, #f4f6f9 55%);

  .loginCard {
    width: min(440px, 100%);
    border-radius: 12px;

    .brandBlock {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 24px;

      .brandIcon {
        width: 46px;
        height: 46px;
        flex-shrink: 0;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }

      .brandText {
        h1 {
          margin: 0 0 6px;
          font-size: 19px;
          font-weight: 600;
          color: #111827;
        }

        p {
          margin: 0;
          font-size: 13px;
          line-height: 1.5;
          color: #6b7280;
        }
      }
    }

    .errorAlert {
      margin-bottom: 16px;
    }

    .submitBtn {
      width: 100%;
      height: 40px;
      font-weight: 500;
    }

    .securityHint {
      margin-top: 16px;
      font-size: 12px;
      line-height: 1.5;
      color: #9ca3af;
      text-align: center;
    }
  }
}
</style>
