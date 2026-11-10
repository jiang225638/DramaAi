/*! toonflowTool:{"name":"videoUpscale","version":"1.7.0","displayName":"视频AI超分","description":"调用PIX aliyun-video-superres 接口对工作区视频做AI超分放大，返回超分后的视频文件。","prompt":"当需要对视频做AI超分放大时使用 videoUpscale 工具。输入为工作区内的视频相对路径（如 assets/input.mp4），可指定输出码率 bitrate(1-20)，省略则用插件配置的默认码率。工具会自动上传视频、提交超分异步任务、轮询等待完成并把结果下载保存到工作区 assets 目录，返回超分后视频的工作区相对路径。源视频须为工作区已有文件，单个视频不超过1024MB、短边不小于360px。任务耗时随视频时长增加，等待时不要中断。","readme":"# 视频AI超分（PIX aliyun-video-superres）\r\n\r\n为 Agent 提供视频超分能力：读取工作区视频 → 上传到PIX → 提交超分任务 → 轮询 → 下载结果保存回工作区。\r\n\r\n## 调用方式\r\n\r\n```json\r\n{ \"videoPath\": \"assets/input.mp4\", \"bitrate\": 12 }\r\n```\r\n\r\n- `videoPath`（必填）：工作区视频**相对路径**，如 `assets/test.mp4`，不能是绝对路径。\r\n- `bitrate`（可选）：输出码率 1-20，默认 10，越大画质和体积越高。\r\n\r\n成功后 `details.outputVideoPath` 为超分视频的工作区相对路径（位于 `assets/`）。\r\n\r\n## 配置\r\n\r\n在“设置 → 插件市场 → 已安装”找到“视频AI超分”，点击“配置”：\r\n1. 填写PIX 的 API 密钥（sk-开头）；\r\n2. 设置默认输出码率（1-20，默认10）和最大等待分钟数（默认10）。\r\n\r\n密钥只保存在本机插件配置，不会上传到其他位置。\r\n\r\n## 限制\r\n\r\n- 源视频最大 1024MB，短边 ≥ 360px；\r\n- 超分为异步长任务，耗时随视频时长和分辨率增大；\r\n- 输入必须为工作区相对路径。\r\n","components":[],"author":"demo","github":"","configRules":[{"type":"input","field":"apiKey","title":"PIX API密钥(sk-xxx)","value":"","props":{"type":"password","showPassword":true,"placeholder":"sk-xxxxxxxxxxxx"}},{"type":"inputNumber","field":"defaultBitrate","title":"默认输出码率(1-20)","value":10,"props":{"min":1,"max":20,"step":1}},{"type":"inputNumber","field":"maxWaitMinutes","title":"最大等待分钟数","value":10,"props":{"min":1,"max":60,"step":1}}]} */
// @bun
import { z as zz } from "toonflow:tool-zod";

// 工具入参：工作区视频相对路径（必须相对路径，对齐 workspace 校验规则） + 可选码率
const inputSchema = zz.strictObject({
  videoPath: zz
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => !/^[\\/]/.test(p) && !p.includes(":") && p.split(/[\\/]/).every((s) => s && s !== "." && s !== ".."),
      "videoPath 必须是工作区内的相对路径（如 assets/input.mp4），不能是绝对路径，不能包含 .."
    )
    .describe("工作区视频相对路径，如 assets/input.mp4"),
  bitrate: zz.number().int().min(1).max(20).optional().describe("输出码率1-20，省略则用插件配置的默认码率"),
});

// 插件配置：PIX密钥 + 默认码率 + 最大等待分钟数
const configSchema = zz.strictObject({
  apiKey: zz.string().default(""),
  defaultBitrate: zz.number().int().min(1).max(20).default(10),
  maxWaitMinutes: zz.number().int().min(1).max(60).default(10),
});

const BASE_URL = "https://pix.token6688.com";
const MODEL = "aliyun-video-superres";

// 生成不依赖 crypto 的唯一ID
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const plugin = {
  validateConfig(rawConfig) {
    return configSchema.parse(rawConfig);
  },
  createTools(ctx) {
    return [
      {
        name: "videoUpscale",
        label: "视频AI超分",
        description:
          "调用PIX aliyun-video-superres 接口对工作区视频做AI超分放大，自动上传、提交异步任务、轮询并下载结果保存回工作区，返回超分视频相对路径。",
        promptSnippet: "对视频执行AI超分放大，输入工作区视频相对路径，返回超分后视频路径。",
        parameters: zz.toJSONSchema(inputSchema, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(toolCallId, params, signal) {
          let step = "初始化";
          try {
            signal?.throwIfAborted();
            const args = inputSchema.parse(params);

            step = "解析插件配置";
            const config = configSchema.parse(ctx.config);
            const apiKey = config.apiKey.trim();
            if (!apiKey) {
              return {
                content: [{ type: "text", text: "请先在插件配置中填写 PIX API 密钥（sk-xxx）后再使用视频超分。" }],
                details: { error: "未配置API密钥" },
              };
            }
            const bitrate = args.bitrate ?? config.defaultBitrate;
            const fileName = String(args.videoPath).split(/[\\/]/).pop() || "input.mp4";

            step = "读取视频文件(files.readFile)";
            // 直接传工作区相对路径，readFile 内部会自己 resolvePath；
            // 不要再传第二参 true（那是“从skills目录解析”标志，不是二进制标志），否则会触发 paths 校验异常
            const dataIn = await ctx.files.readFile(args.videoPath);

            step = "上传视频到PIX(fetch /v1/files)";
            const form = new FormData();
            form.append("file", new Blob([dataIn], { type: "video/mp4" }), fileName);
            const upRes = await fetch(`${BASE_URL}/v1/files`, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}` },
              body: form,
              signal,
            });
            const upJson = await upRes.json().catch(() => ({}));
            if (!upRes.ok) throw new Error(`上传失败 HTTP ${upRes.status}: ${JSON.stringify(upJson)}`);
            const publicUrl = upJson.url || upJson.data?.url || upJson.data?.file?.url || upJson.id;
            if (!publicUrl) throw new Error(`上传未返回公网URL: ${JSON.stringify(upJson)}`);

            step = "提交超分任务(fetch /v1/media/generate)";
            const subRes = await fetch(`${BASE_URL}/v1/media/generate`, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: MODEL,
                prompt: "视频AI超分",
                params: { url: publicUrl, bitrate },
                client_request_id: `upscale-${uid()}`,
              }),
              signal,
            });
            const subJson = await subRes.json().catch(() => ({}));
            if (!subRes.ok) throw new Error(`提交失败 HTTP ${subRes.status}: ${JSON.stringify(subJson)}`);
            const taskId = subJson.data?.task_id || subJson.task_id || subJson.id;
            if (!taskId) throw new Error(`未获取到超分 task_id: ${JSON.stringify(subJson)}`);

            step = "轮询任务结果(fetch /v1/tasks)";
            const maxMs = config.maxWaitMinutes * 60 * 1000;
            const start = Date.now();
            let outputUrl = "";
            while (Date.now() - start < maxMs) {
              signal?.throwIfAborted();
              await new Promise((r) => setTimeout(r, 3000));
              const tRes = await fetch(`${BASE_URL}/v1/tasks/${taskId}`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal,
              });
              if (!tRes.ok) continue;
              const task = await tRes.json().catch(() => ({}));
              if (task.is_final === true) {
                if (task.status !== "completed") {
                  throw new Error(`任务失败: ${JSON.stringify(task.error || task)}`);
                }
                outputUrl = task.output_url || task.output?.url || task.result?.videos?.[0]?.url || task.result?.url;
                break;
              }
            }
            if (!outputUrl) throw new Error(`超分任务超时（${config.maxWaitMinutes}分钟）`);

            step = "下载超分结果(fetch output_url，带超时和重试)";
            // CDN 下载可能不稳定，给 fetch 加超时并自动重试，避免拿到不完整文件或无限挂起
            let buf = null;
            let lastDlErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const dlSignal = signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
                  : AbortSignal.timeout(120000);
                const dlRes = await fetch(outputUrl, { signal: dlSignal });
                if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
                buf = await dlRes.arrayBuffer();
                break;
              } catch (dlErr) {
                lastDlErr = dlErr;
                await new Promise((r) => setTimeout(r, 2000));
              }
            }
            if (!buf) throw new Error(`下载超分结果失败：${lastDlErr?.message || "多次重试仍未成功"}`);

            step = "写入输出文件(files.writeFile)";
            const rel = `assets/${uid()}_upscaled.mp4`;
            // writeFile 内部自己 resolvePath，直接传相对路径即可
            await ctx.files.writeFile(rel, new Uint8Array(buf));

            return {
              content: [{ type: "text", text: `视频超分完成，输出文件：${rel}` }],
              details: { outputVideoPath: rel, path: rel, mediaType: "video", mimeType: "video/mp4" },
            };
          } catch (e) {
            // 兜底：不抛裸错，返回带失败步骤的合法结构
            const msg = e?.message || String(e);
            return {
              content: [{ type: "text", text: `视频超分失败（失败步骤：${step}）：${msg}` }],
              details: { step, error: msg },
            };
          }
        },
      },
    ];
  },
};

export default plugin;
