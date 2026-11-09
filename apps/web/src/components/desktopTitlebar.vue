<template>
  <teleport to="body">
    <div class="desktopWindowControls electrobun-webkit-app-region-no-drag" role="toolbar" aria-label="窗口控制">
      <button
        class="controlButton"
        type="button"
        aria-label="最小化"
        title="最小化"
        @click="minimizeWindow">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="controlButton"
        type="button"
        :aria-label="isMaximized ? '向下还原' : '最大化'"
        :title="isMaximized ? '向下还原' : '最大化'"
        @click="toggleMaximize">
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 2.5V2a.8.8 0 0 1 .8-.8H8a.8.8 0 0 1 .8.8v4.2a.8.8 0 0 1-.8.8h-.5" fill="none" stroke="currentColor" stroke-width="1.15" />
          <rect x="1.2" y="3" width="5.8" height="5.8" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.15" />
        </svg>
      </button>
      <button
        class="controlButton closeButton"
        type="button"
        aria-label="关闭"
        title="关闭"
        @click="closeWindow">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const DRAG_CLASS = "electrobun-webkit-app-region-drag";
const DRAG_ZONE_HEIGHT = 40;
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[contenteditable='true']",
  ".el-button",
  ".el-segmented",
  ".el-input",
  ".el-select",
  ".el-dropdown",
  ".dv-tab",
  ".resizeHandle",
  ".desktopWindowControls",
  ".electrobun-webkit-app-region-no-drag",
].join(",");

const isMaximized = ref(false);

function sendToHost(payload: Record<string, unknown>) {
  const hostWindow = window as Window & { __electrobunSendToHost?: (message: unknown) => void };
  hostWindow.__electrobunSendToHost?.(payload);
}

function minimizeWindow() {
  clearDragState();
  sendToHost({ type: "windowMinimize" });
}

function toggleMaximize() {
  clearDragState();
  sendToHost({ type: "windowMaximize" });
}

function closeWindow() {
  clearDragState();
  sendToHost({ type: "windowClose" });
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
  if (!element) return false;
  return Boolean(element.closest(INTERACTIVE_SELECTOR));
}

function clearDragState() {
  document.body?.classList.remove(DRAG_CLASS);
}

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0 || event.clientY > DRAG_ZONE_HEIGHT || isInteractiveTarget(event.target)) {
    clearDragState();
    return;
  }
  if (!isMaximized.value) {
    // 在捕获阶段标记拖拽，让 Electrobun 内置 preload 的 mousedown 监听器自动启动原生平滑移动
    document.body.classList.add(DRAG_CLASS);
  }
}

function handleDoubleClick(event: MouseEvent) {
  if (event.button !== 0 || event.clientY > DRAG_ZONE_HEIGHT || isInteractiveTarget(event.target)) return;
  clearDragState();
  toggleMaximize();
}

function handleWindowState(event: Event) {
  const detail = (event as CustomEvent<{ maximized?: boolean }>).detail;
  if (detail && typeof detail.maximized === "boolean") {
    isMaximized.value = detail.maximized;
    if (detail.maximized) clearDragState();
  }
}

onMounted(() => {
  const root = document.documentElement;
  root.style.setProperty("--desktopTitlebarHeight", "34px");
  root.style.setProperty("--desktopWindowControlsWidth", "138px");
  window.addEventListener("mousedown", handleMouseDown, true);
  window.addEventListener("mouseup", clearDragState, true);
  window.addEventListener("blur", clearDragState);
  window.addEventListener("dblclick", handleDoubleClick, true);
  window.addEventListener("dramaai:windowState", handleWindowState);
  sendToHost({ type: "queryWindowState" });
});

onBeforeUnmount(() => {
  clearDragState();
  const root = document.documentElement;
  root.style.removeProperty("--desktopTitlebarHeight");
  root.style.removeProperty("--desktopWindowControlsWidth");
  window.removeEventListener("mousedown", handleMouseDown, true);
  window.removeEventListener("mouseup", clearDragState, true);
  window.removeEventListener("blur", clearDragState);
  window.removeEventListener("dblclick", handleDoubleClick, true);
  window.removeEventListener("dramaai:windowState", handleWindowState);
});
</script>

<style lang="scss" scoped>
.desktopWindowControls {
  position: fixed;
  top: 0;
  inset-inline-end: 0;
  z-index: 3000;
  display: flex;
  align-items: stretch;
  height: 34px;
  user-select: none;
  pointer-events: auto;
  -webkit-app-region: no-drag;

  .controlButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 34px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--el-text-color-regular);
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
    -webkit-app-region: no-drag;

    &:hover {
      background: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
      color: var(--el-text-color-primary);
    }

    &:active {
      background: color-mix(in srgb, var(--el-text-color-primary) 14%, transparent);
    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: -2px;
    }

    &.closeButton {
      &:hover {
        background: #e81123;
        color: #ffffff;
      }

      &:active {
        background: #c50f1f;
        color: #ffffff;
      }
    }
  }
}
</style>
