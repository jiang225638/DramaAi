<template>
  <loginCard v-if="!adminSession.authenticated" @loggedIn="handleLoggedIn" />

  <div v-else class="managePage">
    <header class="topBar">
      <div class="brandGroup">
        <div class="logoBadge">
          <icon-key :size="20" />
        </div>
        <div>
          <h1>DramaAI 卡密管理平台</h1>
          <span class="serverLabel">节点：{{ adminSession.serverUrl }}</span>
        </div>
      </div>

      <div class="headerActions">
        <el-button type="primary" @click="generateVisible = true">
          <template #icon><icon-plus :size="16" /></template>
          批量制卡
        </el-button>
        <el-button @click="loadList">
          <template #icon><icon-refresh :size="16" /></template>
          刷新
        </el-button>
        <el-button plain @click="handleLogout">
          <template #icon><icon-logout :size="16" /></template>
          退出
        </el-button>
      </div>
    </header>

    <main class="pageBody">
      <statsBar :stats="stats" :activeStatus="query.status" @selectStatus="handleStatusSelect" />

      <el-card class="tableCard" shadow="never">
        <div class="filterToolbar">
          <div class="filterLeft">
            <el-input
              v-model="query.keyword"
              placeholder="搜索卡密或备注..."
              clearable
              class="keywordInput"
              @keyup.enter="handleSearch"
              @clear="handleSearch">
              <template #prefix>
                <icon-search :size="15" />
              </template>
            </el-input>

            <el-select v-model="query.tier" class="filterSelect" @change="handleSearch">
              <el-option label="全部档位" value="all" />
              <el-option label="终身买断" value="lifetime" />
              <el-option label="年度专业" value="yearly" />
              <el-option label="月度体验" value="monthly" />
            </el-select>

            <el-select v-model="query.status" class="filterSelect" @change="handleSearch">
              <el-option label="全部状态" value="all" />
              <el-option label="未使用" value="unused" />
              <el-option label="已激活" value="active" />
              <el-option label="已过期" value="expired" />
              <el-option label="已封禁" value="banned" />
            </el-select>

            <el-button type="primary" plain @click="handleSearch">查询</el-button>
            <el-button @click="handleResetFilters">重置</el-button>
          </div>

          <div class="filterRight">
            <el-button :disabled="!exportTargetRows.length" @click="handleCopyKeys">
              <template #icon><icon-copy :size="15" /></template>
              {{ selectedRows.length ? `复制已选 (${selectedRows.length})` : "复制本页卡密" }}
            </el-button>
            <el-button :disabled="!exportTargetRows.length" @click="handleExportCsv">
              <template #icon><icon-download :size="15" /></template>
              {{ selectedRows.length ? `导出已选 (${selectedRows.length})` : "导出本页 CSV" }}
            </el-button>
          </div>
        </div>

        <el-table
          v-loading="loading"
          :data="list"
          stripe
          rowKey="id"
          class="licenseTable"
          @selectionChange="handleSelectionChange">
          <el-table-column type="selection" width="44" />

          <el-table-column label="卡密" minWidth="240">
            <template #default="{ row }">
              <div class="cardKeyCell">
                <code>{{ row.cardKey }}</code>
                <el-button size="small" text @click="handleCopySingle(row.cardKey)">
                  <icon-copy :size="14" />
                </el-button>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="授权档位" width="110">
            <template #default="{ row }">
              <el-tag :type="tierTagType(row.tier)" effect="light" size="small">
                {{ tierLabel(row.tier) }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="96">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" effect="dark" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="已绑设备" width="108">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row.cardKey)">
                {{ row.deviceCount }} / {{ row.maxDevices }} 台
              </el-button>
            </template>
          </el-table-column>

          <el-table-column label="有效期 / 到期时间" minWidth="170">
            <template #default="{ row }">
              <span>{{ formatValidity(row) }}</span>
            </template>
          </el-table-column>

          <el-table-column label="备注" minWidth="160" showOverflowTooltip>
            <template #default="{ row }">
              <span class="noteText">{{ row.note || "—" }}</span>
            </template>
          </el-table-column>

          <el-table-column label="创建时间" minWidth="165">
            <template #default="{ row }">
              <span>{{ formatDateTime(row.createdAt) }}</span>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="210" fixed="right">
            <template #default="{ row }">
              <div class="rowActions">
                <el-button link type="primary" @click="openDetail(row.cardKey)">详情</el-button>

                <el-popconfirm
                  v-if="row.status !== 'banned'"
                  title="确定封禁此卡密吗？"
                  confirmButtonText="封禁"
                  cancelButtonText="取消"
                  @confirm="handleToggleBan(row, 'ban')">
                  <template #reference>
                    <el-button link type="danger">封禁</el-button>
                  </template>
                </el-popconfirm>
                <el-button v-else link type="success" @click="handleToggleBan(row, 'unban')">解封</el-button>

                <el-popconfirm
                  title="确定清空该卡密的所有设备绑定吗？"
                  confirmButtonText="清空"
                  cancelButtonText="取消"
                  @confirm="handleResetRow(row)">
                  <template #reference>
                    <el-button link type="warning" :disabled="row.deviceCount === 0">清空设备</el-button>
                  </template>
                </el-popconfirm>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="paginationBar">
          <el-pagination
            :currentPage="query.page"
            :pageSize="query.limit"
            :pageSizes="[20, 50, 100]"
            :total="total"
            background
            layout="total, sizes, prev, pager, next"
            @update:currentPage="handlePageChange"
            @update:pageSize="handleSizeChange" />
        </div>
      </el-card>
    </main>

    <generateDialog v-model:visible="generateVisible" @generated="loadList" />
    <detailDrawer v-model:visible="detailVisible" :cardKey="selectedCardKey" @updated="loadList" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { IconCopy, IconDownload, IconKey, IconLogout, IconPlus, IconRefresh, IconSearch } from "@tabler/icons-vue";
import {
  fetchLicenseList,
  resetLicenseBindings,
  updateLicense,
  type LicenseItem,
  type LicenseStats,
  type LicenseStatus,
  type LicenseTier,
} from "@/api/licenseAdmin";
import {
  adminCredentials,
  adminSession,
  handleSessionError,
  hasStoredSecret,
  loginAdmin,
  logoutAdmin,
} from "@/stores/adminSession";
import {
  copyText,
  downloadTextFile,
  exportLicensesCsv,
  formatDateTime,
  formatValidity,
  statusLabel,
  statusTagType,
  tierLabel,
  tierTagType,
} from "@/utils/format";
import loginCard from "@/components/loginCard.vue";
import statsBar from "@/components/statsBar.vue";
import generateDialog from "@/components/generateDialog.vue";
import detailDrawer from "@/components/detailDrawer.vue";

const loading = ref(false);
const list = ref<LicenseItem[]>([]);
const selectedRows = ref<LicenseItem[]>([]);
const total = ref(0);
const generateVisible = ref(false);
const detailVisible = ref(false);
const selectedCardKey = ref("");

const stats = ref<LicenseStats>({
  total: 0,
  unused: 0,
  active: 0,
  expired: 0,
  banned: 0,
  totalDevices: 0,
});

const query = reactive<{
  page: number;
  limit: number;
  keyword: string;
  status: "all" | LicenseStatus;
  tier: "all" | LicenseTier;
}>({
  page: 1,
  limit: 20,
  keyword: "",
  status: "all",
  tier: "all",
});

const exportTargetRows = computed(() => (selectedRows.value.length ? selectedRows.value : list.value));

onMounted(async () => {
  if (hasStoredSecret()) {
    const ok = await loginAdmin(adminSession.serverUrl, adminSession.adminSecret);
    if (ok) {
      await loadList();
    }
  }
});

async function handleLoggedIn() {
  await loadList();
}

function handleLogout() {
  logoutAdmin();
  list.value = [];
  selectedRows.value = [];
}

async function loadList() {
  loading.value = true;
  try {
    const result = await fetchLicenseList(adminCredentials.value, {
      page: query.page,
      limit: query.limit,
      keyword: query.keyword,
      status: query.status,
      tier: query.tier,
    });
    list.value = result.list;
    total.value = result.total;
    stats.value = result.stats;
    selectedRows.value = [];
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "加载卡密列表失败");
    }
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  query.page = 1;
  void loadList();
}

function handleResetFilters() {
  query.keyword = "";
  query.tier = "all";
  query.status = "all";
  query.page = 1;
  void loadList();
}

function handleStatusSelect(status: "all" | LicenseStatus) {
  query.status = status;
  query.page = 1;
  void loadList();
}

function handlePageChange(page: number) {
  query.page = page;
  void loadList();
}

function handleSizeChange(size: number) {
  query.limit = size;
  query.page = 1;
  void loadList();
}

function handleSelectionChange(rows: LicenseItem[]) {
  selectedRows.value = rows;
}

function openDetail(cardKey: string) {
  selectedCardKey.value = cardKey;
  detailVisible.value = true;
}

async function handleCopySingle(cardKey: string) {
  try {
    await copyText(cardKey);
    ElMessage.success(`已复制 ${cardKey}`);
  } catch {
    ElMessage.error("复制失败");
  }
}

async function handleCopyKeys() {
  const keys = exportTargetRows.value.map((item) => item.cardKey).join("\n");
  try {
    await copyText(keys);
    ElMessage.success(`已复制 ${exportTargetRows.value.length} 个卡密`);
  } catch {
    ElMessage.error("复制失败");
  }
}

function handleExportCsv() {
  const csv = exportLicensesCsv(exportTargetRows.value);
  const dateTag = new Date().toISOString().slice(0, 10);
  downloadTextFile(`dramaai-licenses-${dateTag}.csv`, csv, "text/csv;charset=utf-8");
}

async function handleToggleBan(row: LicenseItem, action: "ban" | "unban") {
  try {
    await updateLicense(adminCredentials.value, {
      cardKey: row.cardKey,
      action,
    });
    ElMessage.success(action === "ban" ? "卡密已封禁" : "卡密已解封");
    await loadList();
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "操作失败");
    }
  }
}

async function handleResetRow(row: LicenseItem) {
  try {
    await resetLicenseBindings(adminCredentials.value, row.cardKey);
    ElMessage.success(`已清空 ${row.cardKey} 的设备绑定`);
    await loadList();
  } catch (error) {
    if (!handleSessionError(error)) {
      ElMessage.error(error instanceof Error ? error.message : "清空绑定失败");
    }
  }
}
</script>

<style scoped lang="scss">
.managePage {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px 24px 36px;

  .topBar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;

    .brandGroup {
      display: flex;
      align-items: center;
      gap: 12px;

      .logoBadge {
        width: 40px;
        height: 40px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--el-color-primary);
        color: #ffffff;
      }

      h1 {
        margin: 0 0 2px;
        font-size: 18px;
        font-weight: 600;
        color: #111827;
      }

      .serverLabel {
        font-size: 12px;
        color: #6b7280;
      }
    }

    .headerActions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
  }

  .pageBody {
    display: flex;
    flex-direction: column;
    gap: 16px;

    .tableCard {
      border-radius: 10px;
      border-color: #e5e7eb;

      .filterToolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;

        .filterLeft,
        .filterRight {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .keywordInput {
          width: 240px;
        }

        .filterSelect {
          width: 124px;
        }
      }

      .licenseTable {
        width: 100%;

        .cardKeyCell {
          display: flex;
          align-items: center;
          gap: 6px;

          code {
            font-size: 13px;
            font-weight: 600;
            color: #111827;
          }
        }

        .noteText {
          color: #4b5563;
        }

        .rowActions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
      }

      .paginationBar {
        display: flex;
        justify-content: flex-end;
        margin-top: 16px;
      }
    }
  }
}
</style>
