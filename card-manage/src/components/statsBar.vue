<template>
  <div class="statsGrid">
    <button
      v-for="card in statCards"
      :key="card.key"
      type="button"
      class="statCard"
      :class="{ active: card.filterStatus !== null && activeStatus === card.filterStatus, clickable: card.filterStatus !== null }"
      @click="handleCardClick(card.filterStatus)">
      <span class="statLabel">{{ card.label }}</span>
      <strong class="statValue" :class="card.tone">{{ card.value }}</strong>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { LicenseStats, LicenseStatus } from "@/api/licenseAdmin";

type StatusFilter = "all" | LicenseStatus;

const props = defineProps<{
  stats: LicenseStats;
  activeStatus: StatusFilter;
}>();

const emit = defineEmits<{
  selectStatus: [status: StatusFilter];
}>();

const statCards = computed(() => [
  { key: "total", label: "全部卡密", value: props.stats.total, tone: "toneDefault", filterStatus: "all" as StatusFilter },
  { key: "unused", label: "未使用", value: props.stats.unused, tone: "toneInfo", filterStatus: "unused" as StatusFilter },
  { key: "active", label: "已激活", value: props.stats.active, tone: "toneSuccess", filterStatus: "active" as StatusFilter },
  { key: "expired", label: "已过期", value: props.stats.expired, tone: "toneWarning", filterStatus: "expired" as StatusFilter },
  { key: "banned", label: "已封禁", value: props.stats.banned, tone: "toneDanger", filterStatus: "banned" as StatusFilter },
  { key: "devices", label: "已绑定设备", value: props.stats.totalDevices, tone: "tonePrimary", filterStatus: null },
]);

function handleCardClick(status: StatusFilter | null) {
  if (status === null) return;
  emit("selectStatus", status);
}
</script>

<style scoped lang="scss">
.statsGrid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 1100px) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  @media (max-width: 640px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .statCard {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 14px 16px;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    text-align: left;
    font: inherit;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;

    &.clickable {
      cursor: pointer;

      &:hover {
        border-color: var(--el-color-primary-light-5);
      }
    }

    &.active {
      border-color: var(--el-color-primary);
      box-shadow: 0 0 0 2px var(--el-color-primary-light-9);
    }

    .statLabel {
      font-size: 12px;
      color: #6b7280;
    }

    .statValue {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.2;

      &.toneDefault { color: #111827; }
      &.toneInfo { color: #4b5563; }
      &.toneSuccess { color: #16a34a; }
      &.toneWarning { color: #d97706; }
      &.toneDanger { color: #dc2626; }
      &.tonePrimary { color: var(--el-color-primary); }
    }
  }
}
</style>
