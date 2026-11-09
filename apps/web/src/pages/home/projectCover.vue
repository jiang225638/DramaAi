<template>
  <span ref="element" class="projectCover" aria-hidden="true">
    <img v-if="coverUrl && !failed" :src="coverUrl" alt="" draggable="false" decoding="async" @error="failed = true" />
    <icon-folder v-else :size="36" />
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { IconFolder } from "@tabler/icons-vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ directory: string }>();
const element = ref<HTMLElement>();
const visible = ref(false);
const coverUrl = ref("");
const failed = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    visible.value = true;
    observer?.disconnect();
  }, { rootMargin: "200px" });
  if (element.value) observer.observe(element.value);
});
onBeforeUnmount(() => observer?.disconnect());

watch([visible, () => props.directory], async ([visible, directory], _previous, onCleanup) => {
  coverUrl.value = "";
  failed.value = false;
  if (!visible || !directory) return;
  const controller = new AbortController();
  let release = () => {};
  onCleanup(() => { controller.abort(); release(); });
  const files = useWorkspaceFiles(directory);
  try {
    // ACT: 先确认工作区根目录下存在 assets 文件夹再递归查找首图，避免新项目尚未创建 assets 时触发 404 ENOENT。
    const { entries: rootEntries } = await files.list("", controller.signal).catch(() => ({ entries: [] }));
    const assetsEntry = rootEntries.find(entry => entry.type === "directory" && entry.name.toLowerCase() === "assets");
    if (!assetsEntry || controller.signal.aborted) return;
    const directories = [assetsEntry.path];
    for (let index = 0; index < directories.length && !controller.signal.aborted; index++) {
      const { entries } = await files.list(directories[index]!, controller.signal).catch(() => ({ entries: [] }));
      if (controller.signal.aborted) return;
      const image = entries.find(entry => entry.type === "file" && /\.(avif|apng|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(entry.name));
      if (image) {
        const preview = files.acquireUrl(image.path);
        release = preview.release;
        const url = await preview.url;
        if (!controller.signal.aborted) coverUrl.value = url;
        return;
      }
      directories.push(...entries.filter(entry => entry.type === "directory").map(entry => entry.path));
    }
  } catch {
    // 封面读取失败不影响打开项目，继续显示文件夹图标。
  }
});
</script>

<style lang="scss" scoped>
.projectCover {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  color: var(--el-text-color-secondary);

  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }
}
</style>
