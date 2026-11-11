import type { CustomProviderModel } from "@/stores/settings";

export interface PresetLanguageProvider {
  id: string;
  label: string;
  apiUrl: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  signupUrl?: string;
  readme?: string;
  models: CustomProviderModel[];
}

export const presetLanguageProviders: PresetLanguageProvider[] = [
  {
    id: "siliconflow",
    label: "硅基流动 (SiliconFlow · 国内高性价比首选)",
    apiUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-completions",
    signupUrl: "https://cloud.siliconflow.cn",
    readme: "国内高性价比大模型聚合平台，内置 DeepSeek-V3 / R1、Qwen2.5-72B 等短剧创作主力模型。[前往硅基流动获取 API Key](https://cloud.siliconflow.cn)",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek-V3 (剧本拆解主力)", contextWindow: 64000, maxOutputTokens: 8192 },
      { id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek-R1 (深度推理分镜)", contextWindow: 64000, maxOutputTokens: 8192 },
      { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5-72B", contextWindow: 32768, maxOutputTokens: 4096 },
    ],
  },
  {
    id: "deepseek-official",
    label: "DeepSeek 官方开放平台",
    apiUrl: "https://api.deepseek.com/v1",
    protocol: "openai-completions",
    signupUrl: "https://platform.deepseek.com",
    readme: "DeepSeek 官方直连 API，内置 DeepSeek-V3 与 DeepSeek-R1 预设模型。[前往 DeepSeek 开放平台获取 API Key](https://platform.deepseek.com)",
    models: [
      { id: "deepseek-chat", label: "DeepSeek-V3", contextWindow: 64000, maxOutputTokens: 8192 },
      { id: "deepseek-reasoner", label: "DeepSeek-R1", contextWindow: 64000, maxOutputTokens: 8192 },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter (出海全模型聚合)",
    apiUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-completions",
    signupUrl: "https://openrouter.ai/keys",
    readme: "海外主流大模型聚合平台，支持 Claude 3.5 Sonnet、GPT-4o 等出海短剧剧本创作主力模型。[前往 OpenRouter 获取 API Key](https://openrouter.ai/keys)",
    models: [
      { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet (欧美短剧剧本天花板)", contextWindow: 200000, maxOutputTokens: 8192 },
      { id: "openai/gpt-4o", label: "GPT-4o", contextWindow: 128000, maxOutputTokens: 16384 },
    ],
  },
];
