<template>
  <el-dialog
    :modelValue="visible"
    title="批量生成卡密"
    width="min(560px, 94vw)"
    alignCenter
    destroyOnClose
    :closeOnClickModal="false"
    @update:modelValue="handleVisibleChange">
    <el-form v-if="!generatedKeys.length" labelPosition="top" class="generateForm">
      <el-form-item label="授权档位">
        <el-radio-group v-model="form.tier" @change="handleTierChange">
          <el-radio-button value="lifetime">终身买断 (DRAMA-LIFE)</el-radio-button>
          <el-radio-button value="yearly">年度专业 (DRAMA-YEAR)</el-radio-button>
          <el-radio-button value="monthly">月度体验 (DRAMA-MO)</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <div class="formRow">
        <el-form-item label="生成数量 (1 ~ 100)">
          <el-input-number v-model="form.count" :min="1" :max="100" controlsPosition="right" class="fullWidth" />
        </el-form-item>

        <el-form-item label="单卡可绑定设备上限">
          <el-input-number v-model="form.maxDevices" :min="1" :max="50" controlsPosition="right" class="fullWidth" />
        </el-form-item>
      </div>

      <el-form-item label="有效天数（首次激活起算，买断卡固定为 0 表示永久）">
        <el-input-number
          v-model="form.durationDays"
          :min="0"
          :max="3650"
          :disabled="form.tier === 'lifetime'"
          controlsPosition="right"
          class="fullWidth" />
      </el-form-item>

      <el-form-item label="批次 / 渠道备注">
        <el-input
          v-model="form.note"
          maxlength="200"
          showWordLimit
          placeholder="例如：面包多首发批次 / 闲鱼自动发货"
          clearable />
      </el-form-item>
    </el-form>

    <div v-else class="resultPanel">
      <el-alert
        :title="`已成功生成 ${generatedKeys.length} 个卡密，未激活前不会消耗有效期`"
        type="success"
        showIcon
        :closable="false" />

      <div class="resultToolbar">
        <el-button type="primary" size="small" @click="handleCopyAll">
          <template #icon><icon-copy :size="15" /></template>
          复制全部卡密
        </el-button>
        <el-button size="small" @click="handleDownloadTxt">
          <template #icon><icon-download :size="15" /></template>
          导出 TXT
        </el-button>
        <el-button size="small" @click="resetToForm">继续生成一批</el-button>
      </div>

      <el-input
        :modelValue="generatedKeysText"
        type="textarea"
        :rows="10"
        readonly
        class="keysTextarea" />
    </div>

    <template #footer>
      <div class="dialogFooter">
        <el-button @click="handleVisibleChange(false)">
          {{ generatedKeys.length ? "完成关闭" : "取消" }}
        </el-button>
        <el-button
          v-if="!generatedKeys.length"
          type="primary"
          :loading="submitting"
          @click="handleSubmit">
          立即生成并入库
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { IconCopy, IconDownload } from "@tabler/icons-vue";
import { generateLicenses, type LicenseTier } from "@/api/licenseAdmin";
import { adminCredentials, handleSessionError } from "@/stores/adminSession";
import { copyText, downloadTextFile } from "@/utils/format";

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  generated: [];
}>();

const form = reactive({
  tier: "lifetime" as LicenseTier,
  count: 10,
  durationDays: 0,
  maxDevices: 2,
  note: "",
});

const submitting = ref(false);
const generatedKeys = ref<string[]>([]);
const generatedKeysText = computed(() => generatedKeys.value.join("\n"));

watch(
  () => props.visible,
  (open) => {
    if (open) {
      generatedKeys.value = [];
    }
  },
);

function handleTierChange(tier: string | number | boolean | undefined) {
  if (tier === "lifetime") {
    form.durationDays = 0;
    form.maxDevices = 2;
  } else if (tier === "yearly") {
    form.durationDays = 365;
    form.maxDevices = 2;
  } else {
    form.durationDays = 30;
    form.maxDevices = 1;
  }
}

function handleVisibleChange(value: boolean) {
  emit("update:visible", value);
}

function resetToForm() {
  generatedKeys.value = [];
}

async function handleSubmit() {
  submitting.value = true;
  try {
    const result = await generateLicenses(adminCredentials.value, {
      tier: form.tier,
      count: form.count,
      durationDays: form.tier === "lifetime" ? 0 : form.durationDays,
      maxDevices: form.maxDevices,
      note: form.note.trim(),
    });
    generatedKeys.value = result.keys;
    ElMessage.success(`成功生成 ${result.count} 个卡密`);
    emit("generated");
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "生成卡密失败");
    }
  } finally {
    submitting.value = false;
  }
}

async function handleCopyAll() {
  try {
    await copyText(generatedKeysText.value);
    ElMessage.success(`已复制 ${generatedKeys.value.length} 个卡密到剪贴板`);
  } catch {
    ElMessage.error("复制失败，请手动全选文本框内容");
  }
}

function handleDownloadTxt() {
  const dateTag = new Date().toISOString().slice(0, 10);
  downloadTextFile(`dramaai-keys-${form.tier}-${dateTag}.txt`, `${generatedKeysText.value}\n`);
}
</script>

<style scoped lang="scss">
.generateForm {
  .formRow {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .fullWidth {
    width: 100%;
  }
}

.resultPanel {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .resultToolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .keysTextarea {
    :deep(textarea) {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
    }
  }
}

.dialogFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
