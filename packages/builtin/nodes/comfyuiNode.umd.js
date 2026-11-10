/*! toonflowNode:{"displayName":"ComfyUI 本地工作流","author":"Local Plugin","github":"","configRules":[],"version":"0.12.9","readme":"连接本地 ComfyUI，智能识别工作流输入、主要参数与分支开关。普通工作流界面保留用户尺寸，管理界面临时自适应展开，返回后恢复原尺寸，异常退出后也能恢复。每次生成新建媒体结果节点，自动断开旧结果的输入连线，保留历史内容。","serverTool":"/*! toonflowTool:{\"name\":\"comfyuiNode\",\"version\":\"1.0.1\",\"displayName\":\"ComfyUI 本地工作流\",\"description\":\"画布节点内置实时进度服务。\",\"prompt\":\"仅查询 ComfyUI 节点实时进度服务，不提交或重试工作流。\",\"readme\":\"服务代码随节点文件安装，由 Toonflow 节点服务加载器管理。\",\"components\":[],\"author\":\"Local Plugin\",\"github\":\"\",\"configRules\":[]} *\u002f\nimport { createServer } from \"node:http\";\nimport { randomUUID } from \"node:crypto\";\n\n// A tool plugin runs on the server, where WebSocket does not carry the canvas Origin.\nfunction startProgressBridge({ port = 18189, Socket = globalThis.WebSocket } = {}) {\n  const sessions = new Map();\n  const eventTypes = new Set([\"status\", \"execution_start\", \"executing\", \"execution_cached\",\n    \"progress\", \"progress_state\", \"executed\", \"execution_success\", \"execution_error\", \"execution_interrupted\"]);\n  function remove(id) {\n    const session = sessions.get(id);\n    if (!session) return;\n    sessions.delete(id);\n    session.socket.onmessage = session.socket.onclose = session.socket.onerror = null;\n    session.socket.close();\n  }\n  const server = createServer(async (req, res) => {\n    res.setHeader(\"Content-Type\", \"application/json\");\n    res.setHeader(\"Cache-Control\", \"no-store\");\n    const reply = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };\n    try {\n      // Desktop WebView may omit Origin; its browser-controlled Referer still identifies the page.\n      const source = req.headers.origin === undefined ? req.headers.referer : req.headers.origin;\n      let parsed;\n      try { parsed = source && new URL(source); } catch { /* Reject invalid or opaque sources below. *\u002f }\n      if (!parsed || ![\"http:\", \"https:\"].includes(parsed.protocol) ||\n          parsed.username || parsed.password || ![\"127.0.0.1\", \"localhost\", \"[::1]\"].includes(parsed.hostname)) {\n        reply(403, { error: \"Only local Toonflow origins are allowed\" }); return;\n      }\n      const origin = parsed.origin;\n      if (req.headers.host !== `127.0.0.1:${server.address().port}`) {\n        reply(403, { error: \"Invalid bridge host\" }); return;\n      }\n      res.setHeader(\"Access-Control-Allow-Origin\", origin);\n      res.setHeader(\"Vary\", \"Origin, Referer\");\n      res.setHeader(\"Access-Control-Allow-Methods\", \"POST, OPTIONS\");\n      res.setHeader(\"Access-Control-Allow-Headers\", \"Content-Type\");\n      res.setHeader(\"Access-Control-Allow-Private-Network\", \"true\");\n      if (req.method === \"OPTIONS\") { res.writeHead(204); res.end(); return; }\n      if (req.method !== \"POST\" || !String(req.headers[\"content-type\"]).startsWith(\"application/json\")) {\n        reply(405, { error: \"Use JSON POST\" }); return;\n      }\n      let text = \"\";\n      for await (const chunk of req) {\n        text += chunk;\n        if (text.length > 16384) { reply(413, { error: \"Request too large\" }); return; }\n      }\n      let body;\n      try { body = JSON.parse(text); } catch { reply(400, { error: \"Invalid JSON\" }); return; }\n      if (req.url === \"/open\") {\n        let target;\n        try { target = new URL(body.baseUrl); } catch { /* Validated below. *\u002f }\n        if (!target || ![\"http:\", \"https:\"].includes(target.protocol) || target.username || target.password ||\n            typeof body.clientId !== \"string\" || !/^[\\w-]{1,160}$/.test(body.clientId)) {\n          reply(400, { error: \"Invalid ComfyUI address or client ID\" }); return;\n        }\n        if (sessions.size >= 32) { reply(429, { error: \"Too many progress sessions\" }); return; }\n        target.pathname = target.pathname.replace(/\\/$/, \"\") + \"/ws\";\n        target.protocol = target.protocol === \"https:\" ? \"wss:\" : \"ws:\";\n        target.search = new URLSearchParams({ clientId: body.clientId }).toString();\n        target.hash = \"\";\n        const id = randomUUID(), socket = new Socket(target.toString());\n        const session = { socket, origin, events: [], cursor: 0, connected: false, lastRead: Date.now() };\n        sessions.set(id, session);\n        socket.onmessage = event => {\n          if (typeof event.data !== \"string\" || event.data.length > 2 * 1024 * 1024) return;\n          let message;\n          try { message = JSON.parse(event.data); } catch { return; }\n          if (!eventTypes.has(message.type)) return;\n          session.events.push({ cursor: ++session.cursor, message });\n          if (session.events.length > 256) session.events.shift();\n        };\n        const connected = await new Promise(resolve => {\n          const timeout = setTimeout(() => resolve(false), 2500);\n          const settle = ok => { clearTimeout(timeout); session.connected = ok; resolve(ok); };\n          socket.onopen = () => settle(true);\n          socket.onerror = socket.onclose = () => settle(false);\n        });\n        if (!connected) { remove(id); reply(502, { error: \"ComfyUI progress connection failed\" }); return; }\n        reply(200, { service: \"toonflow-comfyui-progress\", version: 1, sessionId: id }); return;\n      }\n      const session = sessions.get(body.sessionId);\n      if (!session || session.origin !== origin) { reply(404, { error: \"Progress session expired\" }); return; }\n      session.lastRead = Date.now();\n      if (req.url === \"/close\") { remove(body.sessionId); reply(200, { closed: true }); return; }\n      if (req.url === \"/events\") {\n        const after = Number(body.after);\n        if (!Number.isSafeInteger(after) || after < 0 || after > session.cursor) {\n          reply(400, { error: \"Invalid event cursor\" }); return;\n        }\n        if (session.events.length && after < session.events[0].cursor - 1) {\n          reply(409, { error: \"Progress events were missed\" }); return;\n        }\n        reply(200, { connected: session.connected, cursor: session.cursor,\n          events: session.events.filter(event => event.cursor > after) }); return;\n      }\n      reply(404, { error: \"Unknown progress operation\" });\n    } catch { if (!res.headersSent) reply(500, { error: \"Progress bridge request failed\" }); else res.end(); }\n  });\n  server.requestTimeout = 5000;\n  const cleanup = setInterval(() => {\n    for (const [id, session] of sessions) if (Date.now() - session.lastRead > 60000) remove(id);\n  }, 15000);\n  cleanup.unref();\n  const service = {\n    get url() { return `http://127.0.0.1:${server.address()?.port}`; },\n    ready: new Promise((resolve, reject) => {\n      server.once(\"error\", reject);\n      server.listen(port, \"127.0.0.1\", () => { server.unref(); resolve(); });\n    }),\n    async close() {\n      clearInterval(cleanup);\n      for (const id of sessions.keys()) remove(id);\n      server.closeAllConnections();\n      await new Promise(resolve => server.close(resolve));\n    }\n  };\n  return service;\n}\n\nfunction ensureProgressBridge({ port = 18189, key = Symbol.for(\"toonflow.comfyui.progressBridge.v1\") } = {}) {\n  if (globalThis[key]) return globalThis[key];\n  const service = startProgressBridge({ port });\n  globalThis[key] = service;\n  service.ready.catch(error => {\n    delete globalThis[key];\n    service.close().catch(() => {});\n    console.warn(`ComfyUI progress bridge: ${error.code || error.message}`);\n  });\n  return service;\n}\n\n\n\nconst key = Symbol.for(\"toonflow.comfyui.nodeProgress.v2\");\nfunction service() {\n  if (!globalThis[key]) {\n    const pending = (async () => {\n      const oldKey = Symbol.for(\"toonflow.comfyui.nodeProgress.v1\");\n      const previous = globalThis[oldKey];\n      if (previous) {\n        await previous.close();\n        if (globalThis[oldKey] === previous) delete globalThis[oldKey];\n      }\n      const bridge = ensureProgressBridge({ port: 18190, key: Symbol.for(\"toonflow.comfyui.nodeProgressBridge.v2\") });\n      await bridge.ready;\n      return bridge;\n    })();\n    globalThis[key] = pending;\n    pending.catch(() => { if (globalThis[key] === pending) delete globalThis[key]; });\n  }\n  return globalThis[key];\n}\nexport default {\n  validateConfig() {\n    service().catch(error => console.warn(`ComfyUI node progress: ${error.code || error.message}`));\n    return {};\n  },\n  async createTools() {\n    await service();\n    return [{\n      name: \"comfyuiNodeProgressStatus\",\n      label: \"ComfyUI 节点进度状态\",\n      description: \"查询画布节点内置的实时进度服务，不提交任务、不调用模型。\",\n      parameters: { type: \"object\", properties: {}, additionalProperties: false },\n      async execute() {\n        const bridge = await service();\n        return { content: [{ type: \"text\", text: \"ComfyUI 节点内置进度服务已启动\" }],\n          details: { url: bridge.url, version: 1 } };\n      }\n    }];\n  }\n};\n"} */
(function (root, factory) {
  if (typeof exports === "object" && typeof module !== "undefined") {
    module.exports = factory(require("vue"), require("@vue-flow/core"), require("element-plus"));
  } else if (typeof define === "function" && define.amd) {
    define(["vue", "@vue-flow/core", "element-plus"], factory);
  } else {
    root.toonflowNodes = root.toonflowNodes || {};
    root.toonflowNodes.comfyuiNode = factory(root.toonflowNodeHost.vue, root.toonflowNodeHost.vueFlow, root.toonflowNodeHost.elementPlus);
  }
})(this, function (Vue, VueFlow, ElementPlus) {
  const { defineComponent, ref, computed, h, watchEffect, nextTick } = Vue;
  const { useNode, useVueFlow } = VueFlow;
  /*! Official Toonflow node scaffold d7366e36ba30943cf308121c28011b45bbf922e0
MIT License

Copyright (c) 2026 HBAI-Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
var nodeScaffold=(function(S,e,C,k){"use strict";var ee={outline:{xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":2,"stroke-linecap":"round","stroke-linejoin":"round"},filled:{xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"currentColor",stroke:"none"}};const N=(n,s,l,p)=>({color:y="currentColor",size:c=24,stroke:i=2,title:g,class:d,...f},{attrs:r,slots:m})=>{let h=[...p.map(M=>e.h(...M)),...m.default?[m.default()]:[]];return g&&(h=[e.h("title",g),...h]),e.h("svg",{...ee[n],width:c,height:c,...r,class:["tabler-icon",`tabler-icon-${s}`],...n==="filled"?{fill:y}:{"stroke-width":i??ee[n]["stroke-width"],stroke:y},...f},h)};var Be=N("outline","box","Box",[["path",{d:"M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5",key:"svg-0"}],["path",{d:"M12 12l8 -4.5",key:"svg-1"}],["path",{d:"M12 12l0 9",key:"svg-2"}],["path",{d:"M12 12l-8 -4.5",key:"svg-3"}]]);var Oe=N("outline","chevron-right","ChevronRight",[["path",{d:"M9 6l6 6l-6 6",key:"svg-0"}]]);var De=N("outline","circle-dashed","CircleDashed",[["path",{d:"M8.56 3.69a9 9 0 0 0 -2.92 1.95",key:"svg-0"}],["path",{d:"M3.69 8.56a9 9 0 0 0 -.69 3.44",key:"svg-1"}],["path",{d:"M3.69 15.44a9 9 0 0 0 1.95 2.92",key:"svg-2"}],["path",{d:"M8.56 20.31a9 9 0 0 0 3.44 .69",key:"svg-3"}],["path",{d:"M15.44 20.31a9 9 0 0 0 2.92 -1.95",key:"svg-4"}],["path",{d:"M20.31 15.44a9 9 0 0 0 .69 -3.44",key:"svg-5"}],["path",{d:"M20.31 8.56a9 9 0 0 0 -1.95 -2.92",key:"svg-6"}],["path",{d:"M15.44 3.69a9 9 0 0 0 -3.44 -.69",key:"svg-7"}]]);var $e=N("outline","circle-dot","CircleDot",[["path",{d:"M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",key:"svg-0"}],["path",{d:"M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",key:"svg-1"}]]);var Ae=N("outline","copy-plus","CopyPlus",[["path",{d:"M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z",key:"svg-1"}],["path",{d:"M4.012 16.737a2 2 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1",key:"svg-2"}],["path",{d:"M11 14h6",key:"svg-3"}],["path",{d:"M14 11v6",key:"svg-4"}]]);var te=N("outline","copy","Copy",[["path",{d:"M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z",key:"svg-0"}],["path",{d:"M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1",key:"svg-1"}]]);var ze=N("outline","download","Download",[["path",{d:"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2",key:"svg-0"}],["path",{d:"M7 11l5 5l5 -5",key:"svg-1"}],["path",{d:"M12 4l0 12",key:"svg-2"}]]);var oe=N("outline","folder-plus","FolderPlus",[["path",{d:"M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5",key:"svg-0"}],["path",{d:"M16 19h6",key:"svg-1"}],["path",{d:"M19 16v6",key:"svg-2"}]]);var Re=N("outline","loader-2","Loader2",[["path",{d:"M12 3a9 9 0 1 0 9 9",key:"svg-0"}]]);var Ie=N("outline","maximize","Maximize",[["path",{d:"M4 8v-2a2 2 0 0 1 2 -2h2",key:"svg-0"}],["path",{d:"M4 16v2a2 2 0 0 0 2 2h2",key:"svg-1"}],["path",{d:"M16 4h2a2 2 0 0 1 2 2v2",key:"svg-2"}],["path",{d:"M16 20h2a2 2 0 0 0 2 -2v-2",key:"svg-3"}]]);var He=N("outline","refresh","Refresh",[["path",{d:"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4",key:"svg-0"}],["path",{d:"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4",key:"svg-1"}]]);var ne=N("outline","trash","Trash",[["path",{d:"M4 7l16 0",key:"svg-0"}],["path",{d:"M10 11l0 6",key:"svg-1"}],["path",{d:"M14 11l0 6",key:"svg-2"}],["path",{d:"M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12",key:"svg-3"}],["path",{d:"M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3",key:"svg-4"}]]);function ae(n){const s=Array.isArray(n)?n:[n];return s.every(l=>typeof l=="string")?s.flatMap(l=>l.split(",")).map(l=>l.trim()).filter(Boolean):[]}function A(n,s){const l=ae(n),p=ae(s);return l.length>0&&p.length>0&&(l.includes("*")||p.includes("*")||l.some(y=>p.includes(y)))}const ie=(n,s)=>{if(n.source===n.target)return!1;const{sourceNode:l,targetNode:p}=s,y=Array.isArray(l?.data.handles)?l.data.handles:[],c=Array.isArray(p?.data.handles)?p.data.handles:[],i=y.find(d=>d?.id===n.sourceHandle&&d.type==="source"),g=c.find(d=>d?.id===n.targetHandle&&d.type==="target");if(!i||!g||!A(i.dataType,g.dataType))return!1;try{return!p.isValidTargetPos||p.isValidTargetPos(n,s)===!0}catch(d){return console.error("节点连接校验失败",d),!1}};function Pe(n){if(!n||typeof n!="object"||!("dataType"in n)||!("value"in n))return!1;const{dataType:s,value:l}=n;switch(s){case"STRING":return typeof l=="string";case"BOOLEAN":return typeof l=="boolean";case"INT":return typeof l=="number"&&Number.isSafeInteger(l);case"FLOAT":return typeof l=="number"&&Number.isFinite(l);case"IMAGE":case"MASK":case"VIDEO":case"AUDIO":case"FILE":{const p=s==="MASK"?"image":s.toLowerCase();return!!l&&typeof l=="object"&&"url"in l&&typeof l.url=="string"&&!!l.url.trim()&&"mimeType"in l&&typeof l.mimeType=="string"&&(s==="FILE"?/^[^/\s]+\/[^/\s]+$/.test(l.mimeType):l.mimeType.startsWith(`${p}/`)&&l.mimeType.length>p.length+1)}default:return!1}}function z(n,s){return Array.isArray(n)?n.find(l=>l.id===s):n.get(s)}function re(n,s,l,p){const y=z(l,n)?.data?.handles?.find(c=>c.type==="target"&&c.id===s);return y?p.filter(c=>c.target===n&&c.targetHandle===s).flatMap(c=>{const i=z(l,c.source),g=i?.data?.handles?.find(d=>d.type==="source"&&d.id===c.sourceHandle);return i&&g&&A(g.dataType,y.dataType)?[{node:i,handle:g}]:[]}):[]}function le(n,s){const l=n.data?.outputs;if(!l)return;const p=l[s.id];if(!(p===void 0||!Object.hasOwn(l,s.id))){if(!Pe(p)||!A(p.dataType,s.dataType))throw new Error(`节点 ${n.id} 的输出端口 ${s.id} 值不符合类型声明`);return p}}function Le(n,s,l){const p=z(l,n),y=p?.data?.handles?.find(c=>c.type==="source"&&c.id===s);return p&&y?le(p,y):void 0}function Fe(n,s,l,p){const y=z(l,n)?.data?.handles?.find(c=>c.type==="target"&&c.id===s);return y?re(n,s,l,p).flatMap(({node:c,handle:i})=>{const g=le(c,i);return g?A(g.dataType,y.dataType)?[{...g,source:c.id,sourceHandle:i.id}]:[]:[{source:c.id,sourceHandle:i.id,dataType:i.dataType,value:void 0}]}):[]}const X=Symbol.for("toonflow.targetEdges");function se(n=C.useVueFlow()){const s=n,{nodeLookup:l}=n,p=s[X]??e.computed(()=>Map.groupBy(n.getEdges.value,y=>y.target));return s[X]||Object.defineProperty(s,X,{value:p}),{getTargetSources:(y,c)=>re(y,c,l.value,p.value.get(y)??[]),getTargetValues:(y,c)=>Fe(y,c,l.value,p.value.get(y)??[]),getSourceValue:(y,c)=>Le(y,c,l.value)}}const J=Symbol.for("toonflow.nodeEvents");function We(n=C.useNodeId(),s=C.useVueFlow()){if(!n)throw new Error("请在节点组件中使用 useNodeEvent()，或传入节点 ID");const{getSourceValue:l,getTargetValues:p}=se(s),y=s,c=y[J]??new Map;y[J]||Object.defineProperty(y,J,{value:c});function i(d,f){if(d.startsWith("input:"))return e.watch(()=>p(n,d.slice(6)),M=>f(M),{deep:!0,immediate:!0});if(d.startsWith("output:"))return e.watch(()=>l(n,d.slice(7)),M=>f(M),{deep:!0,immediate:!0});if(d!=="delete"&&d!=="save"&&d!=="copy"&&d!=="canConnect")throw new Error(`未知节点事件：${d}`);let r=c.get(n);r||(r={delete:new Set,save:new Set,copy:new Set,canConnect:new Set},c.set(n,r));const m=r[d];m.add(f);const h=()=>{m.delete(f)&&!r.delete.size&&!r.save.size&&!r.copy.size&&!r.canConnect.size&&c.delete(n)};return e.onScopeDispose(h),h}function g(...d){const f=c.get(n);return d[0]==="canConnect"?[...f?.canConnect??[]].every(r=>r(d[1],d[2])===!0):d[0]==="copy"?(async()=>{const r=s.findNode(n),m={};for(const h of[...f?.copy??[]])Object.assign(m,await h());if(s.findNode(n)!==r||c.get(n)!==f)throw new Error("节点已切换，请重新复制");return m})():(async()=>{if(d[0]==="delete"){const r=s.findNode(n);for(const m of[...f?.save??[]])await m();if(s.findNode(n)!==r||c.get(n)!==f)throw new Error("节点已切换，请重新操作")}for(const r of[...f?.[d[0]]??[]])d[0]==="save"&&d[1]?await r(d[1]):await r()})()}return{on:i,emit:g}}const je={class:"titleBar"},Ue=["tabindex","title","onKeydown"],Ke={class:"cardContainer"},Xe={key:0,class:"loadingContent",role:"status","aria-label":"节点加载中"},de=((n,s)=>{const l=n.__vccOpts||n;for(const[p,y]of s)l[p]=y;return l})(e.defineComponent({inheritAttrs:!1,__name:"nodeSkeleton",props:e.mergeModels({label:{default:"未命名节点"},handles:{default:()=>[]},outputs:{default:()=>({})},icon:{},loading:{type:Boolean},readOnly:{type:Boolean,default:!1},previewReady:{type:Boolean,default:!0},topWidth:{default:"20vw"},bottomWidth:{default:"20vw"},downloadUrl:{},downloadName:{},fullscreenVisible:{type:Boolean,default:!0}},{topVisible:{type:Boolean,default:!1},topVisibleModifiers:{},bottomVisible:{type:Boolean,default:!1},bottomVisibleModifiers:{}}),emits:e.mergeModels(["fullscreen"],["update:topVisible","update:bottomVisible"]),setup(n,{emit:s}){const l=e.useModel(n,"topVisible"),p=e.useModel(n,"bottomVisible"),y=s,c=e.ref(!1),i=n,g=e.computed(()=>[{type:"target",position:C.Position.Left,items:i.handles.filter(o=>o.type==="target")},{type:"source",position:C.Position.Right,items:i.handles.filter(o=>o.type==="source")}]),d=e.computed(()=>Math.max(100,...g.value.map(o=>(o.items.length+1)*44))),{id:f,node:r}=C.useNode(),m=e.inject("nodeDocument",void 0),h=e.computed(()=>i.readOnly?void 0:m?.targets.get(f)),M=e.ref(),x=e.shallowRef();let T;function R(o){if(i.readOnly)throw new Error("只读节点不能挂载到工作区文档");const t=M.value;if(!m||!t||!o.isConnected)throw new Error("节点视图尚未就绪");h.value||(x.value={width:`${t.offsetWidth||r.dimensions.width||220}px`,height:`${t.offsetHeight||r.dimensions.height||128}px`});const a=Symbol();return T=a,m.targets.set(f,o),()=>{T===a&&(T=void 0,m.targets.delete(f),e.nextTick(()=>{h.value||fe([f])}))}}e.watch(()=>i.loading,o=>{i.readOnly||(o?m?.mounts.get(f)===R&&m.mounts.delete(f):m?.mounts.set(f,R))},{immediate:!0}),e.onScopeDispose(()=>{T=void 0,m?.mounts.get(f)===R&&(m.mounts.delete(f),m.targets.delete(f))});const D=e.inject("selectionConnection",void 0),I=We();i.readOnly||(r.isValidTargetPos=(...o)=>!i.readOnly&&I.emit("canConnect",...o));const{d3Zoom:ce,d3Selection:G,zoomActivationKeyCode:Ze,zoomOnPinch:qe,setViewport:Qe,minZoom:_e,maxZoom:et,viewport:Z,vueFlowRef:tt,addNodes:ot,addEdges:nt,toObject:at,getNodes:it,getSelectedNodes:rt,findNode:H,addSelectedNodes:lt,removeSelectedElements:st,removeNodes:dt,removeEdges:ct,updateNodeInternals:fe,screenToFlowCoordinate:ue,connectionLookup:pe,connectionStartHandle:ye,connectionEndHandle:he,connectionStatus:ft,onPaneClick:ut,onPaneContextMenu:pt,onSelectionContextMenu:yt,onConnectStart:ht,onMoveStart:gt,onNodeContextMenu:mt,onNodeDragStart:wt,onNodeClick:kt,onSelectionStart:bt}=C.useVueFlow(),ge=e.inject("batchCanvasHistory",void 0),me=e.computed(()=>{const o=typeof r.style=="function"?r.style(r):r.style;return i.readOnly||h.value?{}:{...o?.width?{width:o.width}:{},...o?.height?{height:o.height}:{}}}),V=e.shallowRef();function Mt(o){if(i.readOnly||i.loading||h.value||o.button!==0||V.value)return;const t=o.currentTarget,a=M.value;if(!a)return;const u=()=>new Promise(b=>{V.value={element:t,pointerId:o.pointerId,point:ue({x:o.clientX,y:o.clientY}),width:a.offsetWidth,height:a.offsetHeight,resolve:b},r.resizing=!0,t.setPointerCapture(o.pointerId)});(ge?ge(u):u()).catch(b=>{B(),k.ElMessage.error(b instanceof Error?b.message:"节点缩放失败")})}function we(o,t){const a=M.value?.querySelector(".titleBar")?.offsetHeight??32,u=typeof r.style=="function"?r.style(r):r.style;r.style={...u,width:`${Math.max(160,o)}px`,height:`${Math.max(d.value+a,t)}px`}}function Ct(o){const t=V.value;if(!t||o.pointerId!==t.pointerId)return;if(i.readOnly||i.loading||h.value||H(f)!==r)return B();const a=ue({x:o.clientX,y:o.clientY});we(t.width+a.x-t.point.x,t.height+a.y-t.point.y)}function B(o){const t=V.value;!t||o&&o.pointerId!==t.pointerId||(V.value=void 0,r.resizing=!1,t.element.hasPointerCapture(t.pointerId)&&t.element.releasePointerCapture(t.pointerId),t.resolve())}function Nt(o){if(i.readOnly||i.loading||h.value||V.value)return;const t=M.value;if(!t||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(o.key))return;o.preventDefault();const a=o.key==="ArrowLeft"?-10:o.key==="ArrowRight"?10:0,u=o.key==="ArrowUp"?-10:o.key==="ArrowDown"?10:0;we(t.offsetWidth+a,t.offsetHeight+u)}e.onScopeDispose(()=>B()),e.watch(()=>[i.readOnly,i.loading,h.value],()=>B());const ke=e.computed(()=>ye.value?.nodeId===f?ye.value:void 0),Tt=e.computed(()=>he.value?.nodeId===f?he.value:void 0),Et=e.computed(()=>D?.value?.nodeId===f?D.value:void 0),vt=e.computed(o=>{const t=new Set(i.handles.filter(a=>pe.value.get(`${f}-${a.type}-${a.id}`)?.size).map(a=>`${a.type}-${a.id}`));return o?.size===t.size&&[...t].every(a=>o.has(a))?o:t});async function St(o){if(h.value)return;const t=o.currentTarget;await e.nextTick();const a=tt.value;if(!a||!t.isConnected)return;const u=a.getBoundingClientRect();if(u.width<=0||u.height<=0)return;const b=[t,...t.querySelectorAll(":scope > .floatingSlot")].filter(E=>E.getClientRects().length).map(E=>E.getBoundingClientRect()),O=Math.min(...b.map(E=>E.left)),w=Math.min(...b.map(E=>E.top)),_=C.pointToRendererPoint({x:O-u.left,y:w-u.top},Z.value),At=C.getTransformForBounds({..._,width:(Math.max(...b.map(E=>E.right))-O)/Z.value.zoom,height:(Math.max(...b.map(E=>E.bottom))-w)/Z.value.zoom},u.width,u.height,_e.value,et.value,.2);await Qe(At,{duration:300})}function xt(o){if(h.value||document.fullscreenElement||!(Ze.value===!0||o.ctrlKey&&qe.value)||!ce.value||!G.value)return;const t=G.value.node()?.getBoundingClientRect();t&&(o.preventDefault(),o.stopPropagation(),ce.value.scaleBy(G.value,2**C.wheelDelta(o),[o.clientX-t.left,o.clientY-t.top]))}const P=e.ref(!1),be=e.computed(()=>!P.value&&(!r.selected||rt.value.length<=1));bt(()=>{P.value=!0}),wt(({nodes:o})=>{o.some(t=>t.id===f)&&(P.value=!0)}),kt(({node:o})=>{o.id===f&&(P.value=!1)});const $=e.ref(!1),L=e.ref(""),Me=e.ref(),q=e.inject("reloadRemoteNode",void 0),F=e.ref(!1),W=e.ref(!1),v=e.ref(),Ce=e.shallowRef({getBoundingClientRect:()=>new DOMRect});ut(()=>v.value?.handleClose()),pt(()=>v.value?.handleClose()),yt(()=>v.value?.handleClose()),ht(()=>v.value?.handleClose()),gt(()=>v.value?.handleClose()),mt(({event:o,node:t})=>{t.id===f?Ne(o):v.value?.handleClose()});async function Vt(){if(!(i.readOnly||!q||F.value)){F.value=!0;try{await q(r.type)}catch(o){k.ElMessage.error(o instanceof Error?o.message:"节点刷新失败")}finally{F.value=!1}}}async function Ne(o){if(i.readOnly)return;o.preventDefault(),h.value&&o.stopPropagation(),v.value?.handleClose();const t="changedTouches"in o?o.changedTouches[0]:o;t&&(Ce.value={getBoundingClientRect:()=>new DOMRect(t.clientX,t.clientY,0,0)},await e.nextTick(),v.value?.handleOpen())}async function Te(){if(!(i.readOnly||W.value)){W.value=!0;try{await I.emit("delete"),dt(f)}catch(o){const t=o?.response?.data?.message;k.ElMessage.error(t||(o instanceof Error?o.message:"节点删除失败"))}finally{W.value=!1}}}const Q=e.inject("copyNodeToClipboard",void 0),j=e.ref(!1),U=e.inject("saveNodeToAssets",void 0),K=e.computed(()=>i.handles.flatMap(o=>{const t=i.outputs[o.id];return o.type!=="source"||!t||t.dataType==="STRING"&&!t.value.trim()?[]:[{label:o.label??o.id,output:t}]}));async function Ee(o){if(!i.readOnly){if(o==="saveAsset"&&U?.(i.label,K.value),o==="clipboard"&&Q&&!j.value){j.value=!0;try{const t=await I.emit("copy"),a={...r.data,...t};await Q({type:r.type,data:a}),k.ElMessage.success("已复制到剪贴板")}catch(t){k.ElMessage.error(t instanceof Error?t.message:"节点复制失败")}finally{j.value=!1}}if(o==="delete"&&Te(),o==="copy"||o==="duplicate"){let t;try{const w=await I.emit("copy");t=JSON.parse(JSON.stringify({...r.data,...w}))}catch(w){k.ElMessage.error(w instanceof Error?w.message:"节点复制失败");return}if(H(f)!==r)return;const a=crypto.randomUUID(),u=o==="duplicate"?at().edges.filter(w=>w.target===f):[],b={x:r.position.x,y:r.position.y+r.dimensions.height+32},O=it.value.filter(w=>w.parentNode===r.parentNode&&w.position.x<b.x+r.dimensions.width&&w.position.x+w.dimensions.width>b.x).sort((w,_)=>w.position.y-_.position.y);for(const w of O)b.y<w.position.y+w.dimensions.height+32&&b.y+r.dimensions.height+32>w.position.y&&(b.y=w.position.y+w.dimensions.height+32);st(),ot({id:a,zIndex:r.zIndex,type:r.type,position:b,data:{...t,label:`${i.label} - 副本`},parentNode:r.parentNode}),await e.nextTick(),lt([H(a)]),nt(u.map(w=>({...JSON.parse(JSON.stringify(w)),id:crypto.randomUUID(),target:a,selected:!1})))}}}async function ve(){i.readOnly||(L.value=i.label,$.value=!0,await e.nextTick(),Me.value?.select())}function Se(){if(i.readOnly||!$.value)return;const o=L.value.trim();o&&(r.data.label=o),$.value=!1}function Bt(o){i.readOnly||o.isComposing||(o.preventDefault(),Se())}function Ot(o){if(o.pointerType==="touch")return;const t=o.currentTarget,a=t.getBoundingClientRect();if(!a.width||!a.height)return;const u=(o.clientX-a.left-a.width/2)/a.width*18,b=(o.clientY-a.top-a.height/2)/a.height*18,O=Math.min(.3,6/(Math.hypot(u,b)||1));t.style.setProperty("--handleX",`${u*O}px`),t.style.setProperty("--handleY",`${b*O}px`)}function xe(o){const t=o.currentTarget;t.style.removeProperty("--handleX"),t.style.removeProperty("--handleY")}function Ve(o){return vt.value.has(`${o.type}-${o.id}`)}function Dt(o){const t=pe.value.get(`${f}-${o.type}-${o.id}`);if(!t?.size)return!1;if(r.selected||r.dragging)return!0;for(const a of t.values()){const u=H(o.type==="source"?a.target:a.source);if(u?.selected||u?.dragging)return!0}return!1}function $t(o){const t=Et.value;if(t?.handles.some(u=>u.id===o.id&&u.type===o.type))return t.status;const a=Tt.value;return a?.id===o.id&&a.type===o.type?ft.value:null}return e.watchEffect(()=>{i.readOnly||i.loading||JSON.stringify(r.data.handles)!==JSON.stringify(i.handles)&&(r.data.handles=i.handles.map(o=>({...o})))}),e.watchEffect(()=>{i.readOnly||i.loading||(r.data.outputs=i.outputs)}),e.watch(()=>JSON.stringify([i.label,i.handles,i.readOnly]),()=>{i.readOnly||i.loading||(ct(o=>o.filter(t=>t.source===f&&!i.handles.some(a=>a.type==="source"&&a.id===t.sourceHandle)||t.target===f&&!i.handles.some(a=>a.type==="target"&&a.id===t.targetHandle))),h.value||fe([f]))},{flush:"post"}),(o,t)=>(e.openBlock(),e.createElementBlock(e.Fragment,null,[h.value?(e.openBlock(),e.createElementBlock("div",{key:0,class:"nodeDocumentPlaceholder",style:e.normalizeStyle(x.value),"aria-hidden":"true"},null,4)):e.createCommentVNode("v-if",!0),(e.openBlock(),e.createBlock(e.Teleport,{to:h.value??"body",disabled:!h.value},[e.createElementVNode("div",e.mergeProps({ref_key:"skeletonElement",ref:M},o.$attrs,{class:["nodeSkeleton",{documentNode:h.value,resized:!!me.value.height,resizing:!!V.value}],style:me.value,onWheelCapture:xt,onDblclick:e.withModifiers(St,["stop"]),onContextmenu:t[27]||(t[27]=a=>h.value&&Ne(a))}),[n.readOnly?e.createCommentVNode("v-if",!0):(e.openBlock(),e.createBlock(e.unref(k.ElDropdown),{key:0,ref_key:"menu",ref:v,trigger:"contextmenu",virtualTriggering:"",virtualRef:Ce.value,placement:"bottom-start",showArrow:!1,showTimeout:0,hideTimeout:0,onCommand:Ee},{dropdown:e.withCtx(()=>[e.createVNode(e.unref(k.ElDropdownMenu),null,{default:e.withCtx(()=>[K.value.length&&e.unref(U)?(e.openBlock(),e.createBlock(e.unref(k.ElDropdownItem),{key:0,command:"saveAsset",icon:e.unref(oe)},{default:e.withCtx(()=>[...t[28]||(t[28]=[e.createTextVNode("保存到素材库",-1)])]),_:1},8,["icon"])):e.createCommentVNode("v-if",!0),e.createVNode(e.unref(k.ElDropdownItem),{divided:!!(K.value.length&&e.unref(U)),command:"copy",icon:e.unref(te)},{default:e.withCtx(()=>[...t[29]||(t[29]=[e.createTextVNode("复制节点",-1)])]),_:1},8,["divided","icon"]),e.createVNode(e.unref(k.ElDropdownItem),{command:"duplicate",icon:e.unref(Ae)},{default:e.withCtx(()=>[...t[30]||(t[30]=[e.createTextVNode("创建副本",-1)])]),_:1},8,["icon"]),e.createVNode(e.unref(k.ElDropdownItem),{command:"delete",icon:e.unref(ne)},{default:e.withCtx(()=>[...t[31]||(t[31]=[e.createTextVNode("删除节点",-1)])]),_:1},8,["icon"]),e.createVNode(e.unref(k.ElDropdownItem),{divided:"",command:"clipboard",icon:e.unref(te),disabled:!e.unref(Q)||j.value},{default:e.withCtx(()=>[...t[32]||(t[32]=[e.createTextVNode(" 复制到剪贴板 ",-1)])]),_:1},8,["icon","disabled"])]),_:1})]),_:1},8,["virtualRef"])),!n.readOnly&&(h.value||l.value&&be.value)?(e.openBlock(),e.createElementBlock("div",{key:1,class:"floatingSlot topSlot nodrag nopan nowheel",style:e.normalizeStyle({width:typeof n.topWidth=="number"?`${n.topWidth}px`:n.topWidth}),onPointerdown:t[4]||(t[4]=e.withModifiers(()=>{},["stop"])),onMousedown:t[5]||(t[5]=e.withModifiers(()=>{},["stop"])),onDblclick:t[6]||(t[6]=e.withModifiers(()=>{},["stop"])),onKeydown:t[7]||(t[7]=e.withModifiers(()=>{},["stop"])),onContextmenu:t[8]||(t[8]=e.withModifiers(()=>{},["stop"]))},[e.renderSlot(o.$slots,"top",{},()=>[e.createVNode(e.unref(k.ElCard),{class:"mediaToolbar",shadow:"never",bodyStyle:{padding:"6px"}},{default:e.withCtx(()=>[e.createVNode(e.unref(k.ElButton),{icon:e.unref(oe),disabled:!K.value.length||!e.unref(U),text:"",title:"添加到素材库","aria-label":"添加到素材库",onClick:t[0]||(t[0]=e.withModifiers(a=>Ee("saveAsset"),["stop"]))},{default:e.withCtx(()=>[...t[33]||(t[33]=[e.createTextVNode("添加到素材库",-1)])]),_:1},8,["icon","disabled"]),e.renderSlot(o.$slots,"topActions",{},void 0,!0),e.createVNode(e.unref(k.ElDivider),{direction:"vertical"}),e.renderSlot(o.$slots,"topRightActions",{},void 0,!0),e.createVNode(e.unref(k.ElButton),{tag:n.downloadUrl?"a":"button",href:n.downloadUrl||void 0,download:n.downloadName,icon:e.unref(ze),disabled:!n.downloadUrl,loading:c.value,"aria-busy":c.value,text:"",title:c.value?"正在保存…":"下载","aria-label":"下载",onDownloadstate:t[1]||(t[1]=a=>c.value=a.detail),onClick:t[2]||(t[2]=e.withModifiers(()=>{},["stop"]))},null,8,["tag","href","download","icon","disabled","loading","aria-busy","title"]),n.fullscreenVisible?(e.openBlock(),e.createBlock(e.unref(k.ElButton),{key:0,icon:e.unref(Ie),disabled:!n.downloadUrl,text:"",title:"全屏","aria-label":"全屏",onClick:t[3]||(t[3]=e.withModifiers(a=>y("fullscreen"),["stop"]))},null,8,["icon","disabled"])):e.createCommentVNode("v-if",!0)]),_:3})],!0)],36)):e.createCommentVNode("v-if",!0),!n.readOnly&&o.$slots.bottom&&(h.value||p.value&&be.value)?(e.openBlock(),e.createElementBlock("div",{key:2,class:"floatingSlot bottomSlot nodrag nopan nowheel",style:e.normalizeStyle({width:typeof n.bottomWidth=="number"?`${n.bottomWidth}px`:n.bottomWidth}),onPointerdown:t[9]||(t[9]=e.withModifiers(()=>{},["stop"])),onMousedown:t[10]||(t[10]=e.withModifiers(()=>{},["stop"])),onDblclick:t[11]||(t[11]=e.withModifiers(()=>{},["stop"])),onKeydown:t[12]||(t[12]=e.withModifiers(()=>{},["stop"])),onContextmenu:t[13]||(t[13]=e.withModifiers(()=>{},["stop"]))},[e.renderSlot(o.$slots,"bottom",{},void 0,!0)],36)):e.createCommentVNode("v-if",!0),e.withDirectives(e.createElementVNode("div",je,[(e.openBlock(),e.createBlock(e.resolveDynamicComponent(n.icon??e.unref(Be)),{class:"titleIcon",size:16,"aria-hidden":"true"})),$.value&&!n.readOnly?e.withDirectives((e.openBlock(),e.createElementBlock("input",{key:0,ref_key:"labelInput",ref:Me,"onUpdate:modelValue":t[14]||(t[14]=a=>L.value=a),class:"labelInput nodrag nopan","aria-label":"节点名称",onPointerdown:t[15]||(t[15]=e.withModifiers(()=>{},["stop"])),onMousedown:t[16]||(t[16]=e.withModifiers(()=>{},["stop"])),onDblclick:t[17]||(t[17]=e.withModifiers(()=>{},["stop"])),onKeydown:[t[18]||(t[18]=e.withModifiers(()=>{},["stop"])),e.withKeys(Bt,["enter"]),t[19]||(t[19]=e.withKeys(e.withModifiers(a=>$.value=!1,["prevent"]),["esc"]))],onBlur:Se},null,544)),[[e.vModelText,L.value]]):(e.openBlock(),e.createElementBlock("span",{key:1,class:"labelText",tabindex:n.readOnly?void 0:0,title:n.readOnly?n.label:`${n.label}（双击编辑名称）`,onDblclick:t[20]||(t[20]=a=>!n.readOnly&&(a.stopPropagation(),ve())),onKeydown:e.withKeys(e.withModifiers(ve,["stop","prevent"]),["enter"])},e.toDisplayString(n.label),41,Ue)),n.readOnly?e.createCommentVNode("v-if",!0):(e.openBlock(),e.createElementBlock("div",{key:2,class:"nodeActions nodrag nopan",onPointerdown:t[21]||(t[21]=e.withModifiers(()=>{},["stop"])),onMousedown:t[22]||(t[22]=e.withModifiers(()=>{},["stop"])),onDblclick:t[23]||(t[23]=e.withModifiers(()=>{},["stop"]))},[e.createVNode(e.unref(k.ElButton),{icon:e.unref(He),loading:n.loading||F.value,disabled:n.loading||!e.unref(q),text:"",title:"刷新节点","aria-label":"刷新节点",onClick:e.withModifiers(Vt,["stop"])},null,8,["icon","loading","disabled"]),e.createVNode(e.unref(k.ElButton),{icon:e.unref(ne),text:"",title:"移除节点","aria-label":"移除节点",onClick:e.withModifiers(Te,["stop"]),loading:W.value},null,8,["icon","loading"])],32))],512),[[e.vShow,!h.value]]),e.createElementVNode("div",Ke,[e.createVNode(e.unref(k.ElCard),{class:e.normalizeClass(["contentCard",{selected:e.unref(r).selected}]),shadow:"never",bodyStyle:{padding:"8px"},style:e.normalizeStyle({minHeight:`${d.value}px`})},{default:e.withCtx(()=>[n.loading?(e.openBlock(),e.createElementBlock("div",Xe,[e.createVNode(e.unref(Re),{class:"loadingIcon",size:24,"aria-hidden":"true"}),t[34]||(t[34]=e.createElementVNode("span",null,"加载中...",-1))])):n.previewReady||h.value?e.renderSlot(o.$slots,"default",{key:1},void 0,!0):e.createCommentVNode("v-if",!0)]),_:3},8,["class","style"]),(e.openBlock(!0),e.createElementBlock(e.Fragment,null,e.renderList(g.value,a=>(e.openBlock(),e.createElementBlock(e.Fragment,{key:a.type},[(e.openBlock(!0),e.createElementBlock(e.Fragment,null,e.renderList(a.items,(u,b)=>e.withDirectives((e.openBlock(),e.createBlock(e.unref(C.Handle),{id:u.id,key:u.id,class:e.normalizeClass(["nodeHandle",{connected:Ve(u),connectedNodeActive:Dt(u),linking:ke.value?.id===u.id&&ke.value.type===a.type}]),type:a.type,connectable:!n.readOnly&&!n.loading,position:a.position,isValidConnection:e.unref(ie),"data-connection-status":$t(u),style:e.normalizeStyle({top:`${(b+1)/(a.items.length+1)*100}%`}),title:`${u.label??u.id} · ${Array.isArray(u.dataType)?u.dataType.join(" / "):u.dataType}`,"aria-label":`${u.label??u.id} · ${Array.isArray(u.dataType)?u.dataType.join(" / "):u.dataType}`,onPointermove:Ot,onPointerleave:xe,onPointercancel:xe},{default:e.withCtx(()=>[(e.openBlock(),e.createBlock(e.resolveDynamicComponent(Ve(u)?e.unref($e):e.unref(De)),{class:"handleIcon",size:18,"aria-hidden":"true"}))]),_:2},1032,["id","class","type","connectable","position","isValidConnection","data-connection-status","style","title","aria-label"])),[[e.vShow,!h.value]])),128))],64))),128)),!n.readOnly&&!n.loading&&!h.value?(e.openBlock(),e.createElementBlock("button",{key:0,class:"resizeCorner nodrag nopan",type:"button","aria-label":"调整节点大小（方向键微调）",onPointerdown:e.withModifiers(Mt,["stop","prevent"]),onPointermove:e.withModifiers(Ct,["stop"]),onPointerup:e.withModifiers(B,["stop"]),onPointercancel:B,onLostpointercapture:B,onKeydown:e.withModifiers(Nt,["stop"]),onMousedown:t[24]||(t[24]=e.withModifiers(()=>{},["stop"])),onClick:t[25]||(t[25]=e.withModifiers(()=>{},["stop"])),onDblclick:t[26]||(t[26]=e.withModifiers(()=>{},["stop"]))},null,32)):e.createCommentVNode("v-if",!0)])],16)],8,["to","disabled"]))],64))}}),[["__scopeId","data-v-9e2d1973"]]);function Je(n){if(!n||/[\\/]/.test(n)||n==="."||n==="..")throw new Error("节点 ID 不能作为文件夹名称");return`assets/${n}`}async function Ye(n,s,l){const p=Je(s);for(const i of["assets",p])await n.mkdir(i).catch(g=>{if(g.response?.data?.data?.code!=="EEXIST")throw g});const y=l.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase()??"",c=`${p}/${crypto.randomUUID()}${y}`;return await n.write(c,l,!0),c}const Y=new WeakMap,Ge=e.defineComponent({name:"ComfyuiMediaResultNode",inheritAttrs:!1,setup(){const{node:n}=C.useNode(),s=C.useVueFlow(),l=se(s),p=e.inject("canvas",void 0),y=e.ref(""),c=e.computed(()=>{const g=n.data.comfyuiMediaResult?.kind,d=s.nodeTypes.value[`remote-${g}Node`];if(!(!d||!["video","audio"].includes(g)))return Y.has(d)||Y.set(d,e.defineComponent({...d,handles:[{id:"in",type:"target",dataType:g.toUpperCase(),label:`${g==="video"?"视频":"音频"}输入`},...(d.handles||[]).filter(f=>f.id!=="in")]})),Y.get(d)}),i=e.computed(()=>{const g=n.data.comfyuiMediaResult?.kind,d=l.getTargetValues(n.id,"in")[0];if(!d||d.dataType!==g?.toUpperCase())return;const r=s.findNode(d.source)?.data.mediaResultNodes?.find(m=>m.nodeId===n.id&&m.kind===g);return r?r.ready?{url:r.path,mimeType:r.mimeType}:void 0:d.value});return e.watch(()=>[i.value?.url,i.value?.mimeType],async([g,d],f,r)=>{y.value="";const m=n.data.comfyuiMediaResult?.kind,h=n.data.outputs?.[m]?.value;if(!g||!d||h?.url===g&&h?.mimeType===d)return;const M=p?.();if(!M?.call){y.value="当前画布未提供媒体节点函数接口";return}const x=new AbortController;r(()=>x.abort());try{const T=`node:set${m==="video"?"Video":"Audio"}`;if(!(await M.call({name:"getNodeTools",args:{nodeIds:[n.id],names:[T],limit:50}},x.signal)).nodeTools?.some(D=>D.name===T&&D.parameters?.properties?.path&&D.parameters?.properties?.mimeType))throw new Error("原生媒体节点未提供兼容的媒体设置函数");await M.call({name:"nodeTools",args:{nodeId:n.id,name:T,args:{path:g,mimeType:d}}},x.signal)}catch(T){x.signal.aborted||(y.value=T.message||String(T))}},{immediate:!0,flush:"post"}),()=>e.h("div",{class:"comfyui-media-result",style:{width:"max-content"}},[c.value?e.h(c.value):e.h(de,{label:n.data.label,handles:[],outputs:n.data.outputs,style:{width:"360px"}},{default:()=>e.h("div",{role:"alert"},"请启用对应的原生视频或音频节点")}),y.value?e.h("div",{role:"alert",style:{color:"var(--el-color-danger)",maxWidth:"360px",overflowWrap:"anywhere"}},y.value):null])}});return S.IconChevronRight=Oe,S.mediaResultNode=Ge,S.nodeSkeleton=de,S.uploadNodeFile=Ye,S.validateConnection=ie,Object.defineProperty(S,Symbol.toStringTag,{value:"Module"}),S})({},Vue,VueFlow,ElementPlus);

if (typeof document !== "undefined" && !document.getElementById("comfyuiNodeScaffoldStyle")) { const style = document.createElement("style"); style.id = "comfyuiNodeScaffoldStyle"; style.textContent = ".nodeSkeleton[data-v-9e2d1973]{position:relative;width:220px;color:var(--el-text-color-primary);text-align:left}.nodeSkeleton.resized[data-v-9e2d1973]{display:flex;flex-direction:column}.nodeSkeleton.resized .titleBar[data-v-9e2d1973]{flex-shrink:0}.nodeSkeleton.resized .cardContainer[data-v-9e2d1973]{flex:1;min-height:0}.nodeSkeleton.resized .cardContainer .contentCard[data-v-9e2d1973]{height:100%;box-sizing:border-box}.nodeSkeleton.resized .cardContainer .contentCard [data-v-9e2d1973] .el-card__body{height:100%;box-sizing:border-box;overflow:auto}.nodeSkeleton.documentNode[data-v-9e2d1973]{display:flex;flex-direction:column;gap:16px;width:100%!important;min-width:0}.nodeSkeleton.documentNode .floatingSlot[data-v-9e2d1973]{position:static;width:100%!important;transform:none}.nodeSkeleton.documentNode .floatingSlot.topSlot[data-v-9e2d1973]{order:0}.nodeSkeleton.documentNode .floatingSlot.bottomSlot[data-v-9e2d1973]{order:2}.nodeSkeleton.documentNode .cardContainer[data-v-9e2d1973]{order:1;min-width:0}.nodeSkeleton:hover .cardContainer .nodeHandle .handleIcon[data-v-9e2d1973]{opacity:1}.nodeSkeleton:hover .titleBar .nodeActions[data-v-9e2d1973]{visibility:visible}:is(.nodeSkeleton:hover,.nodeSkeleton.resizing) .cardContainer .resizeCorner[data-v-9e2d1973]{opacity:.55}.nodeSkeleton .floatingSlot[data-v-9e2d1973]{position:absolute;left:50%;z-index:2;transform:translate(-50%)}.nodeSkeleton .floatingSlot.topSlot[data-v-9e2d1973]{bottom:calc(100% + 12px)}.nodeSkeleton .floatingSlot.bottomSlot[data-v-9e2d1973]{top:calc(100% + 12px)}.nodeSkeleton .floatingSlot .mediaToolbar[data-v-9e2d1973] .el-button{width:auto;min-width:32px;height:32px;margin:0;padding:0 8px;text-decoration:none}.nodeSkeleton .titleBar[data-v-9e2d1973]{display:flex;align-items:center;gap:6px;padding:0 4px 8px;font-size:14px;line-height:20px}.nodeSkeleton .titleBar .titleIcon[data-v-9e2d1973]{flex-shrink:0}.nodeSkeleton .titleBar .labelText[data-v-9e2d1973]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab;-webkit-user-select:none;user-select:none}.nodeSkeleton .titleBar .labelText[data-v-9e2d1973]:active{cursor:grabbing}.nodeSkeleton .titleBar .labelInput[data-v-9e2d1973]{flex:1;min-width:0;width:100%;padding:0 4px;border:1px solid var(--el-color-primary);border-radius:var(--el-border-radius-small);outline:none;background:var(--el-bg-color);color:inherit;font:inherit;line-height:inherit}.nodeSkeleton .titleBar .nodeActions[data-v-9e2d1973]{visibility:hidden;display:flex;flex-shrink:0;gap:2px}.nodeSkeleton .titleBar .nodeActions .el-button[data-v-9e2d1973]{width:24px;height:24px;margin:0;padding:0}.nodeSkeleton .cardContainer[data-v-9e2d1973]{position:relative}.nodeSkeleton .cardContainer .resizeCorner[data-v-9e2d1973]{position:absolute;right:calc(var(--ui-radius-large, var(--el-border-radius-base)) * .293 - 2px);bottom:calc(var(--ui-radius-large, var(--el-border-radius-base)) * .293 - 2px);transform:translate(50%,50%);box-sizing:border-box;width:4px;height:4px;padding:0;border:1px solid var(--el-border-color);border-radius:1px;background:var(--el-bg-color);opacity:0;cursor:nwse-resize;touch-action:none}.nodeSkeleton .cardContainer .resizeCorner[data-v-9e2d1973]:before{content:\"\";position:absolute;inset:-4px}.nodeSkeleton .cardContainer .resizeCorner[data-v-9e2d1973]:focus-visible{opacity:1}.nodeSkeleton .cardContainer .contentCard.selected[data-v-9e2d1973]{border-color:color-mix(in srgb,var(--el-color-primary) 50%,var(--el-border-color-light))}.nodeSkeleton .cardContainer .contentCard .loadingContent[data-v-9e2d1973]{display:flex;min-height:84px;align-items:center;justify-content:center;gap:8px;color:var(--el-text-color-secondary);font-size:12px}.nodeSkeleton .cardContainer .contentCard .loadingContent .loadingIcon[data-v-9e2d1973]{color:var(--el-color-primary);animation:nodeLoading-9e2d1973 1s linear infinite}@media(prefers-reduced-motion:reduce){.nodeSkeleton .cardContainer .contentCard .loadingContent .loadingIcon[data-v-9e2d1973]{animation:none}}.nodeSkeleton .cardContainer .nodeHandle[data-v-9e2d1973]{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border:0;background:transparent;color:var(--el-text-color-secondary)}.nodeSkeleton .cardContainer .nodeHandle.vue-flow__handle-left[data-v-9e2d1973]{left:-12px}.nodeSkeleton .cardContainer .nodeHandle.vue-flow__handle-right[data-v-9e2d1973]{right:-12px}.nodeSkeleton .cardContainer .nodeHandle[data-v-9e2d1973]:before{content:\"\";position:absolute;inset:-13px;border-radius:50%}.nodeSkeleton .cardContainer .nodeHandle .handleIcon[data-v-9e2d1973]{pointer-events:none;opacity:0;transform:translate(var(--handleX, 0px),var(--handleY, 0px));transition:transform .12s ease-out,opacity .12s ease-out}.nodeSkeleton .cardContainer .nodeHandle.connected .handleIcon[data-v-9e2d1973],.nodeSkeleton .cardContainer .nodeHandle.linking .handleIcon[data-v-9e2d1973],.nodeSkeleton .cardContainer .nodeHandle.connecting .handleIcon[data-v-9e2d1973],.nodeSkeleton .cardContainer .nodeHandle[data-connection-status] .handleIcon[data-v-9e2d1973]{opacity:1}.nodeSkeleton .cardContainer .nodeHandle[data-v-9e2d1973]:hover,.nodeSkeleton .cardContainer .nodeHandle.linking[data-v-9e2d1973],.nodeSkeleton .cardContainer .nodeHandle.connecting[data-v-9e2d1973],.nodeSkeleton .cardContainer .nodeHandle[data-connection-status=valid][data-v-9e2d1973]{color:var(--el-color-primary)}.nodeSkeleton .cardContainer .nodeHandle[data-connection-status=invalid][data-v-9e2d1973]{color:var(--el-color-danger);cursor:not-allowed}@media(prefers-reduced-motion:reduce){.nodeSkeleton .cardContainer .nodeHandle .handleIcon[data-v-9e2d1973]{transform:none;transition:none}}@keyframes nodeLoading-9e2d1973{to{transform:rotate(360deg)}}\n"; document.head.appendChild(style); }
  const { nodeSkeleton, uploadNodeFile, IconChevronRight, mediaResultNode } = nodeScaffold;
  function createWorkflowCore() {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = v => JSON.parse(JSON.stringify(v));
  const safe = k => !["__proto__", "prototype", "constructor"].includes(k);
  const NONE_OPTION = "none";
  const h3ReferenceLimits = { image: 9, audio: 3, video: 1 };
  const kinds = { IMAGE: "image", AUDIO: "audio", VIDEO: "video" };
  const names = { image: "图片", audio: "音频", video: "视频", text: "提示词" };
  const fields = {
    ckpt_name: "基础模型", unet_name: "扩散模型", model_name: "模型", clip_name: "文本编码模型", vae_name: "VAE 模型",
    lora_name: "LoRA", strength_model: "LoRA 模型强度", strength_clip: "LoRA 文本强度",
    width: "宽度", height: "高度", aspect_ratio: "画幅", resolution: "分辨率", megapixels: "分辨率（百万像素）",
    duration: "时长（秒）", seconds: "时长（秒）", length: "帧数 / 长度", num_frames: "帧数",
    frames: "帧数", frame_rate: "帧率", fps: "帧率", steps: "步数", extra_steps: "附加步数",
    seed: "种子", noise_seed: "噪声种子", cfg: "CFG", guidance: "引导强度", denoise: "降噪强度",
    sampler_name: "采样器", scheduler: "调度器", voice: "音色", voice_id: "音色", gender: "性别",
    speaker: "说话人", style: "风格", language: "语言", speed: "语速", pitch: "音调", batch_size: "批量",
    multiple: "尺寸倍数", weight_dtype: "模型精度", ref_image_size: "参考图尺寸",
    switch: "分支开关", segment_index: "运行分段", resize_method: "尺寸适配",
    model_file: "语言模型", mmproj: "视觉投影模型", max_images: "参考图上限"
  };
  const aliases = {
    checkpoint: "ckpt_name", checkpoint_name: "ckpt_name", ckpt: "ckpt_name",
    unet: "unet_name", diffusion_model: "unet_name", diffusion_model_name: "unet_name",
    model: "model_name", clip: "clip_name", vae: "vae_name",
    image_width: "width", video_width: "width", output_width: "width", target_width: "width",
    image_height: "height", video_height: "height", output_height: "height", target_height: "height",
    aspectratio: "aspect_ratio", duration_seconds: "duration", duration_sec: "duration",
    num_steps: "steps", sampling_steps: "steps", inference_steps: "steps", num_inference_steps: "steps",
    frame_count: "num_frames", total_frames: "num_frames",
    custom_width: "width", custom_height: "height", "宽度": "width", "高度": "height",
    scale_to_length: "resolution", video_duration: "duration", denoise_strength: "denoise"
  };
  const primaryFields = new Set(["ckpt_name", "unet_name", "model_name", "clip_name", "vae_name",
    "lora_name", "strength_model", "strength_clip", "width", "height", "aspect_ratio", "resolution",
    "megapixels", "duration", "seconds", "length", "num_frames", "frames", "frame_rate", "fps", "steps",
    "switch", "segment_index", "resize_method", "model_file", "mmproj", "max_images"]);
  const helperNode = /resize|scale|crop|pad|tile|preprocess|preview|display|loadimage|loadvideo|load_audio|loadaudio|imagefrombatch|repeatimagebatch/i;
  const fieldOrder = Object.keys(fields);
  const secret = /api.?key|token|password|secret|authorization|credential/i;
  const isLink = (v, w) => Array.isArray(v) && v.length === 2 && own(w, String(v[0])) && Number.isInteger(v[1]) && v[1] >= 0;
  function parseWorkflow(text) {
    let w = typeof text === "string" ? JSON.parse(text) : clone(text);
    if (w?.prompt && !w.prompt.class_type) w = w.prompt;
    if (!w || typeof w !== "object" || Array.isArray(w) || !Object.keys(w).length ||
        !Object.entries(w).every(([id, n]) => safe(id) && n && typeof n.class_type === "string" &&
          n.inputs && typeof n.inputs === "object" && !Array.isArray(n.inputs))) {
      throw new Error("请导入 API Format JSON，不是 ComfyUI 画布 JSON");
    }
    return w;
  }
  function formatNodeErrors(errors) {
    return Object.entries(errors || {}).flatMap(([id, node]) => {
      const reasons = node.errors?.length ? node.errors : [{ message: "节点校验未通过" }];
      return reasons.map(reason => {
        const detail = reason.type === "required_input_missing"
          ? `缺少必填参数 ${reason.extra_info?.input_name || reason.details || ""}`
          : [reason.message || reason.type || "校验失败", reason.details].filter(Boolean).join("：");
        return `节点 ${id}${node.class_type ? `（${node.class_type}）` : ""}：${detail}`;
      });
    }).join("\n");
  }
  function inputTarget(w, nodeId, path) {
    if (!safe(String(nodeId)) || !own(w, nodeId)) throw new Error(`节点 ${nodeId} 不存在`);
    let target = w[nodeId].inputs;
    const parts = String(path || "").split(".");
    if (!parts.length || parts.some(p => !p || !safe(p))) throw new Error(`字段路径不合法：${path}`);
    // ComfyUI autogrow inputs use literal dotted keys, not nested objects.
    if (own(target, path)) return [target, path];
    const encoded = [];
    for (const p of parts.slice(0, -1)) {
      if (!own(target, p)) throw new Error(`节点 ${nodeId} 没有字段 ${path}`);
      let next = target[p];
      if (typeof next === "string") {
        try { next = JSON.parse(next); } catch { throw new Error(`节点 ${nodeId} 的 ${p} 不是有效的 JSON`); }
        encoded.push({ parent: target, key: p, value: next });
      }
      if (!next || typeof next !== "object") throw new Error(`节点 ${nodeId} 没有字段 ${path}`);
      target = next;
    }
    if (!own(target, parts.at(-1))) throw new Error(`节点 ${nodeId} 没有字段 ${path}`);
    return [target, parts.at(-1), encoded];
  }
  function readInput(w, id, path) { const [o, k] = inputTarget(w, id, path); return o[k]; }
  function writeInput(w, id, path, v) {
    const [o, k, encoded = []] = inputTarget(w, id, path); o[k] = v;
    for (const item of encoded.reverse()) item.parent[item.key] = JSON.stringify(item.value);
  }
  function schemaFields(s) { return { ...s?.input?.required, ...s?.input?.optional }; }
  function isH3ReferenceNode(node, infos = {}) {
    return /^MiniMaxH3ReferenceToVideo$/i.test(node.class_type) ||
      /^MiniMaxH3ReferenceToVideo$/i.test(infos[node.class_type]?.name || "");
  }
  function isH3ReferenceWorkflow(w, infos = {}) {
    return Object.values(w).some(node => isH3ReferenceNode(node, infos));
  }
  function spec(s) {
    const meta = s?.[1] || {};
    return { type: Array.isArray(s?.[0]) ? "COMBO" : s?.[0], ...meta,
      options: Array.isArray(s?.[0]) ? s[0] : meta.options };
  }
  function scalar(v) { return ["string", "number", "boolean"].includes(typeof v); }
  function modelField(path) {
    return ["ckpt_name", "unet_name", "model_name", "clip_name", "vae_name", "lora_name"].includes(
      /^clip_name[123]$/.test(path) ? "clip_name" : /^lora_\d+$/.test(path) ? "lora_name" : aliases[path] || path) ||
      ["model_file", "mmproj"].includes(path);
  }
  function executionNodeIds(w, infos = {}) {
    if (Object.values(w).some(node => !infos[node.class_type])) return new Set(Object.keys(w));
    const roots = Object.entries(w).filter(([, node]) => infos[node.class_type]?.output_node === true).map(([id]) => id);
    // Offline or incomplete schemas cannot establish which nodes ComfyUI will execute.
    if (!roots.length) return new Set(Object.keys(w));
    const active = new Set(roots), queue = [...roots];
    for (let i = 0; i < queue.length; i++) for (const value of Object.values(w[queue[i]].inputs)) {
      if (isLink(value, w) && !active.has(String(value[0]))) {
        active.add(String(value[0])); queue.push(String(value[0]));
      }
    }
    return active;
  }
  function resolveModelFiles(w, infos = {}, replacements = {}) {
    const updates = [], issues = [];
    const active = executionNodeIds(w, infos);
    const normalized = value => value.replace(/\\/g, "/").toLowerCase();
    for (const [nodeId, node] of Object.entries(w)) for (const [path, value] of Object.entries(node.inputs)) {
      if (!active.has(nodeId) || !modelField(path) || typeof value !== "string") continue;
      const options = spec(schemaFields(infos[node.class_type])[path]).options;
      if (!options || options.includes(value)) continue;
      const wanted = replacements[path]?.[value] || value;
      const exact = options.filter(v => typeof v === "string" && normalized(v) === normalized(wanted));
      const basename = normalized(wanted).split("/").at(-1);
      const sameFile = exact.length ? exact : options.filter(v =>
        typeof v === "string" && normalized(v).split("/").at(-1) === basename);
      if (sameFile.length === 1) {
        updates.push({ nodeId, path, previous: value, value: sameFile[0] });
      } else issues.push(`节点 ${nodeId} ${fields[path] || path}：${value}${sameFile.length > 1 ? " 有多个同名文件，需重新选择" : " 未安装或已更名，需选择本机文件"}`);
    }
    if (issues.length) throw new Error(`模型文件预检失败（未上传、未提交）：\n${issues.join("\n")}`);
    for (const update of updates) w[update.nodeId].inputs[update.path] = update.value;
    return updates;
  }
  function fillRequiredDefaults(w, infos = {}) {
    const filled = [];
    for (const [nodeId, node] of Object.entries(w)) {
      for (const [path, definition] of Object.entries(infos[node.class_type]?.input?.required || {})) {
        if (!safe(path) || own(node.inputs, path) || secret.test(path)) continue;
        const s = spec(definition), value = s.default;
        if (!scalar(value) || s.forceInput || s.defaultInput || fileKind(node.class_type, path, definition) ||
            promptField(node, path, value, w)) continue;
        const valid = s.type === "BOOLEAN" ? typeof value === "boolean" :
          s.type === "STRING" ? typeof value === "string" :
          s.type === "COMBO" ? s.options?.includes(value) :
          ["INT", "FLOAT"].includes(s.type) && typeof value === "number" && Number.isFinite(value) &&
            (s.type !== "INT" || Number.isSafeInteger(value)) &&
            (s.min === undefined || value >= s.min) && (s.max === undefined || value <= s.max);
        if (!valid) continue;
        node.inputs[path] = value;
        filled.push({ nodeId, path, value });
      }
    }
    return filled;
  }
  function validateRequiredInputs(w, infos = {}) {
    const errors = {};
    const active = executionNodeIds(w, infos);
    for (const [nodeId, node] of Object.entries(w)) {
      if (!active.has(nodeId)) continue;
      for (const [path, definition] of Object.entries(infos[node.class_type]?.input?.required || {})) {
        // Autogrow groups are serialized as flattened slots, not a group input.
        if (spec(definition).type === "COMFY_AUTOGROW_V3" || own(node.inputs, path)) continue;
        errors[nodeId] ??= { class_type: node.class_type, errors: [] };
        errors[nodeId].errors.push({ type: "required_input_missing", extra_info: { input_name: path } });
      }
    }
    const message = formatNodeErrors(errors);
    if (message) throw new Error(`工作流预检失败（未提交）：\n${message}`);
    return w;
  }
  function fileKind(type, path, schema) {
    const s = spec(schema);
    if (type === "XiaozhuguangImageLoader" && path === "image_list") return "image";
    if (s.image_upload || /LoadImage/i.test(type) && /image/i.test(path)) return "image";
    if (s.audio_upload || /LoadAudio/i.test(type) && /audio/i.test(path)) return "audio";
    if (s.video_upload || /(?:LoadVideo|VHS_LoadVideo)/i.test(type) && /^(video|file|path)$/.test(path)) return "video";
    if (/load|upload|input/i.test(type) && /^(?:file_path|filepath|filename|path|image_path|audio_path|video_path)$/.test(path)) {
      if (/image/i.test(type)) return "image";
      if (/audio/i.test(type)) return "audio";
      if (/video/i.test(type)) return "video";
    }
    return null;
  }
  function promptField(node, path, val, w) {
    return typeof val === "string" && !secret.test(path) &&
      (/^(?:(?:positive|negative|user)_?)?(?:prompt|text|lyrics|transcript|speech_text)$/i.test(path) &&
        !/Save|Preview|Display|Label/i.test(node.class_type) ||
        path === "value" && /String|Text/i.test(node.class_type) &&
        Object.values(w).some(n => Object.entries(n.inputs).some(([k, v]) => /prompt|text|lyrics/i.test(k) && isLink(v, w) && w[String(v[0])] === node)));
  }
  function consumerIndex(w) {
    const index = new Map();
    for (const [nodeId, node] of Object.entries(w)) for (const [path, value] of Object.entries(node.inputs)) {
      if (!isLink(value, w)) continue;
      const id = String(value[0]), list = index.get(id) || [];
      list.push({ nodeId, path, node }); index.set(id, list);
    }
    return index;
  }
  function parsedSettings(value) {
    try {
      const data = typeof value === "string" ? JSON.parse(value) : value;
      return data && typeof data === "object" && !Array.isArray(data) ? data : null;
    } catch { return null; }
  }
  function switchField(node, path, info) {
    return (/switch|selector|开关|切换|datablock/i.test(node.class_type + " " + (node._meta?.title || "")) ||
      Object.values(schemaFields(info)).some(def => spec(def).lazy)) &&
      (/^(?:select|select_index|selected_index|switch|boolean|boolean_value|enabled|传输数据)$/i.test(path) ||
        spec(schemaFields(info)[path]).type === "BOOLEAN" && !/_ui|settings/.test(path));
  }
  function controlSource(node, path) {
    return path === "value" && /primitive|constant|^easy (?:int|float|boolean|string)$|UniversalSlider/i.test(node.class_type);
  }
  function controlConsumers(index, id) {
    const seen = new Set([id]), queue = [id], result = [];
    for (let i = 0; i < queue.length; i++) for (const entry of index.get(queue[i]) || []) {
      result.push(entry);
      if (!seen.has(entry.nodeId) && /reroute|math|convert|StringToNumber|NumberToString|BoolNot/i.test(entry.node.class_type)) {
        seen.add(entry.nodeId); queue.push(entry.nodeId);
      }
    }
    return result;
  }
  function negativePrompt(nodeId, path, w, downstream) {
    if (/negative|负面|负向/i.test(path + " " + w[nodeId]._meta?.title)) return true;
    const seen = new Set([nodeId]), queue = [nodeId], polarities = new Set();
    for (let i = 0; i < queue.length; i++) for (const edge of downstream.get(queue[i]) || []) {
      if (/^(?:negative|negative_prompt|负面|负向)$/i.test(edge.path)) { polarities.add("negative"); continue; }
      if (/^(?:positive|positive_prompt|prompt|user_prompt|conditioning|正面|正向)$/i.test(edge.path)) {
        polarities.add("positive"); continue;
      }
      // Follow text routing only, never cross an encoder into both conditioning outputs.
      if (!seen.has(edge.nodeId) && /switch|reroute|text|string|concat/i.test(edge.node.class_type) &&
          !/encode/i.test(edge.node.class_type)) { seen.add(edge.nodeId); queue.push(edge.nodeId); }
    }
    return polarities.has("negative") && !polarities.has("positive");
  }
  function bindingId(b) { return `${b.kind}:${b.mode || "file"}:${b.nodeId}:${b.path}`; }
  const noLora = value => typeof value === "string" && value.toLowerCase() === NONE_OPTION;
  function sortParameters(parameters) {
    return [...parameters].sort((a, b) => (a.tier === "advanced") - (b.tier === "advanced") ||
      (a.category ?? 5) - (b.category ?? 5) ||
      (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || (a.order ?? 0) - (b.order ?? 0) ||
      String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true }) ||
      String(a.path).localeCompare(String(b.path)));
  }
  function parameterRole(node, path) {
    const key = path.toLowerCase();
    const semantic = /^clip_name[123]$/.test(key) ? "clip_name" :
      /^lora_\d+$/.test(key) && /lora/i.test(node.class_type) ? "lora_name" :
      /^strength_\d+$/.test(key) && /lora/i.test(node.class_type) ? "strength_model" : aliases[key] || key;
    if (!own(fields, semantic)) return null;
    const auxiliary = helperNode.test(node.class_type) && /^(?:width|height|aspect_ratio|resolution|megapixels|duration|length|num_frames|frames|frame_rate|fps|steps)$/.test(semantic);
    const audioControl = /audio|speech|tts|music|sound|voice/i.test(node.class_type) &&
      /^(?:voice|voice_id|speaker|gender|language|speed|pitch|style)$/.test(semantic);
    const modelSemantic = semantic === "model_name" ?
      /vae/i.test(node.class_type) ? "vae_name" : /text|clip|t5/i.test(node.class_type) ? "clip_name" :
      /wanvideo|unet|diffusion/i.test(node.class_type) ? "unet_name" : semantic : semantic;
    return { semantic: modelSemantic, tier: primaryFields.has(semantic) && !auxiliary || audioControl ? "primary" : "advanced" };
  }
  function detectOutputs(w, infos = {}) {
    const outputs = [];
    for (const [nodeId, node] of Object.entries(w)) {
      const info = infos[node.class_type], type = node.class_type;
      let kind = /(?:save|preview).*image|image.*(?:save|preview)|ImageSave/i.test(type) ? "image" :
        /VideoCombine|(?:save|preview).*video|video.*(?:save|preview)/i.test(type) ? "video" :
        /(?:save|preview).*audio|audio.*(?:save|preview)/i.test(type) ? "audio" : null;
      if (/VideoCombine/i.test(type) && /^image\//i.test(node.inputs.format || "")) kind = "image";
      if (!kind && info?.output_node) {
        const media = new Set(Object.values(schemaFields(info)).map(def => kinds[spec(def).type]).filter(Boolean));
        if (media.size === 1) kind = [...media][0];
      }
      if (kind) outputs.push({ nodeId, kind, classType: type, label: node._meta?.title || type,
        preview: /preview/i.test(type) || /^preview$/i.test(node.inputs.mode || "") });
    }
    return outputs.sort((a, b) => ["image", "video", "audio"].indexOf(a.kind) - ["image", "video", "audio"].indexOf(b.kind) ||
      String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true }));
  }
  function detect(w, infos = {}, { includeAdvanced = false } = {}) {
    const parameters = [], bindings = [], diagnostics = [];
    const active = executionNodeIds(w, infos);
    const downstream = consumerIndex(w), outputs = detectOutputs(w, infos);
    const selectorSize = Object.entries(w).some(([id, node]) => node.class_type === "XiaozhuguangSelector" &&
      controlConsumers(downstream, id).some(c => /width|height|aspect_ratio|resolution/.test(parameterRole(c.node, c.path)?.semantic || "")));
    const primarySize = selectorSize || Object.values(w).some(node => Object.keys(node.inputs).some(path => {
      const role = parameterRole(node, path);
      return role?.tier === "primary" && /^(?:width|height|resolution|megapixels)$/.test(role.semantic);
    }));
    function roleFor(nodeId, path) {
      const node = w[nodeId];
      if (switchField(node, path, infos[node.class_type])) return { semantic: "switch", tier: "primary" };
      const role = parameterRole(node, path);
      // A final resize is the size control when this workflow has no generation-size node.
      if (role?.tier === "advanced" && !primarySize && /resize|scale/i.test(node.class_type) &&
          /^(?:width|height|resolution|megapixels)$/.test(role.semantic) &&
          downstream.get(nodeId)?.some(c => outputs.some(o => o.nodeId === c.nodeId && !o.preview))) {
        return { ...role, tier: "primary" };
      }
      return role;
    }
    const loraNodes = new Map(Object.entries(w)
      .filter(([, node]) => Object.keys(node.inputs || {}).some(path => /^lora_name$|^lora_\d+$/.test(path)))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([nodeId], index) => [nodeId, index + 1]));
    function parameterGroup(nodeId, semantic, path) {
      const loraIndex = loraNodes.get(nodeId);
      if (loraIndex && ["lora_name", "strength_model", "strength_clip"].includes(semantic)) {
        const slot = path.match(/^(?:lora|strength)_(\d+)$/)?.[1];
        const groupKey = `lora:${nodeId}${slot === undefined ? "" : `:${slot}`}`;
        const groupLabel = `LoRA ${loraIndex}${slot === undefined ? "" : `.${Number(slot) + 1}`}`;
        const order = semantic === "lora_name" ? 0 : semantic === "strength_model" ? 1 : semantic === "strength_clip" ? 2 : 3;
        const label = semantic === "lora_name" ? groupLabel :
          semantic === "strength_model" ? `${groupLabel} 模型强度` :
          path === "strength_clip" ? `${groupLabel} 文本强度` : `${groupLabel} ${fields[semantic] || semantic}`;
        return { label, groupKey, groupLabel, category: 1, groupOrder: loraIndex * 100 + Number(slot || 0), order };
      }
      const group = /^(?:model_name|ckpt_name|unet_name|clip_name|vae_name|model_file|mmproj)$/.test(semantic) ? ["model", "模型分类", 0] :
        /^(?:switch|segment_index|resize_method)$/.test(semantic) ? ["switch", "工作流模式与开关", 110] :
        /width|height|aspect|resolution|megapixel|multiple|ref_image_size/.test(semantic) ? ["size", "画幅与分辨率", 100] :
        /duration|seconds|length|frames|fps|frame_rate/.test(semantic) ? ["timing", "时长与帧率", 200] :
        /steps|seed|cfg|guidance|sampler|scheduler|denoise/.test(semantic) ? ["sampling", "生成设置", 300] :
        /voice|speaker|gender|language|speed|pitch|style/.test(semantic) ? ["audio", "音频设置", 400] :
        ["other", "其它参数", 400];
      return { label: fields[semantic] || semantic, groupKey: group[0] === "model" ? `model:${semantic}` : group[0],
        groupLabel: group[1], category: group[2] / 100 + (group[2] ? 1 : 0), groupOrder: 0,
        order: fieldOrder.indexOf(semantic) };
    }
    function addParameter(nodeId, path, value, role, s = {}, extra = {}, roleNodeId = nodeId) {
      if (!role || !includeAdvanced && role.tier === "advanced") return;
      const { semantic, tier } = role, group = parameterGroup(roleNodeId, semantic, path);
      const loraParameter = loraNodes.has(roleNodeId) && ["lora_name", "strength_model", "strength_clip"].includes(semantic);
      const enumOptions = s.options?.filter(scalar);
      const options = loraParameter && semantic === "lora_name"
        ? [NONE_OPTION, ...new Set((enumOptions ?? [value]).filter(v => scalar(v) && !noLora(v)))] : enumOptions;
      const detectedType = options?.length ? "enum" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text";
      parameters.push({
        key: `auto_${nodeId}_${path.replace(/\W/g, "_")}`, ...group, nodeId, path, type: detectedType,
        defaultValue: value, options, min: s.min, max: s.max, step: s.step, integer: s.type === "INT",
        sourceLabel: w[nodeId]._meta?.title || w[nodeId].class_type,
        detectedType, detectedLabel: extra.label || group.label, semantic, loraParameter, tier,
        ...(tier === "advanced" ? { visible: false } : {}), ...extra
      });
    }
    for (const [nodeId, node] of Object.entries(w)) {
      if (!active.has(nodeId)) continue;
      const schema = schemaFields(infos[node.class_type]);
      const usedBy = controlConsumers(downstream, nodeId);
      const settings = parsedSettings(node.inputs._xz_settings);
      for (const [path, value] of Object.entries(node.inputs)) {
        if (secret.test(path) || !scalar(value)) continue;
        const s = spec(schema[path]);
        const kind = fileKind(node.class_type, path, schema[path]);
        if (kind || promptField(node, path, value, w)) {
          const negative = !kind && negativePrompt(nodeId, path, w, downstream);
          const list = node.class_type === "XiaozhuguangImageLoader" && path === "image_list";
          bindings.push({ kind: kind || "text", mode: list ? "list" : "file", nodeId, path,
            label: node._meta?.title || node.class_type, enabled: !negative, detectedBinding: true,
            ...(list ? { max: Number(node.inputs.max_images) > 0 ? Number(node.inputs.max_images) : 999999,
              detectedMax: Number(node.inputs.max_images) > 0 ? Number(node.inputs.max_images) : 999999,
              capacity: 999999, separator: "\n" } : {}) });
          if (list && (node.inputs.mask_data || node.inputs.crop_data))
            diagnostics.push(`节点 ${nodeId}：批量图片的已有蒙版和裁剪数据会保留，更换参考图后请核对对应区域。`);
          continue;
        }
        let role = roleFor(nodeId, path), roleNodeId = nodeId;
        if (node.class_type === "XiaozhuguangSelector" && path === "label") {
          const options = Object.keys(settings?.labels || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          if (!options.length || options.length > 200 || options.some(v => !safe(v))) {
            diagnostics.push(`节点 ${nodeId}：选择器配置无效，无法还原选项，请在 ComfyUI 保存选择器设置后重新导出。`);
            continue;
          }
          const target = usedBy.map(c => ({ ...c, role: roleFor(c.nodeId, c.path) })).find(c => c.role);
          role = { ...(target?.role || { semantic: "switch" }), tier: "primary" };
          const label = role.semantic === "switch" ? usedBy.some(c => /prompt|text/i.test(c.node.class_type) ||
            /prompt|text/i.test(c.path)) || Object.values(settings.labels).some(v => /提示词/.test(v)) ? "提示词模式" :
            Object.values(settings.labels).some(v => /文生图|图生图|换头|编辑/.test(v)) ? "工作流功能" : node._meta?.title || "工作流分支" : fields[role.semantic];
          addParameter(nodeId, path, value, role, { options }, { label, optionLabels: settings.labels });
          continue;
        }
        if (controlSource(node, path)) {
          const title = node._meta?.title || "";
          const targets = usedBy.map(c => ({ ...c, role: roleFor(c.nodeId, c.path) }))
            .filter(c => c.role && (typeof value !== "boolean" || c.role.semantic === "switch"))
            .sort((a, b) => (a.role.tier === "advanced") - (b.role.tier === "advanced") ||
              fieldOrder.indexOf(a.role.semantic) - fieldOrder.indexOf(b.role.semantic) ||
              a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
          role = /duration|时长|秒/i.test(title) ? { semantic: "duration", tier: "primary" } :
            targets[0]?.role || { semantic: "value", tier: "advanced" };
          if (targets[0] && !/duration|时长|秒/i.test(title)) roleNodeId = targets[0].nodeId;
          const meanings = new Set(targets.filter(t => t.role.tier === "primary").map(t => t.role.semantic));
          if (meanings.size > 1 && !/duration|时长|秒/i.test(title)) {
            role = { semantic: "value", tier: "advanced" };
            diagnostics.push(`节点 ${nodeId}：同一常量控制 ${[...meanings].map(k => fields[k] || k).join("、")}，已放入高级参数，请确认用途。`);
          }
        }
        let extra = role?.semantic === "switch" ? { label: node._meta?.title || fields.switch, booleanLabels: settings?.labels } : {};
        let definition = s;
        if (role?.semantic === "switch" && typeof value !== "boolean") {
          const target = w[roleNodeId], branches = Object.keys(target.inputs).map(k => k.match(/^(?:value|input_?)(\d+)$/))
            .filter(Boolean).map(match => ({ key: match[0], index: Number(match[1]) })).sort((a, b) => a.index - b.index);
          if (branches.length && /switch/i.test(target.class_type)) {
            const options = branches.map(b => typeof value === "string" ? String(b.index) : b.index);
            definition = { ...s, options };
            extra = { ...extra, optionLabels: Object.fromEntries(branches.map(b => {
              const link = target.inputs[b.key], source = isLink(link, w) && w[String(link[0])];
              return [String(b.index), `${b.index} · ${source?._meta?.title || source?.class_type || b.key}`];
            })) };
          }
        }
        addParameter(nodeId, path, value, role, definition, extra, roleNodeId);
      }
      if (node.class_type === "WatermarkRemovalDirector") {
        const timeline = parsedSettings(node.inputs.timeline_data);
        if (timeline) {
          const base = "timeline_data";
          if (typeof timeline.globalPrompt === "string") bindings.push({ kind: "text", mode: "file", nodeId,
            path: `${base}.globalPrompt`, label: "导演台全局提示词", enabled: true, detectedBinding: true });
          for (const [key, label, inputOrder] of [["referenceVideo", "导演台原视频", 0], ["maskVideo", "导演台蒙版视频", 1]]) {
            if (typeof timeline[key]?.fileName === "string") bindings.push({ kind: "video", mode: "director",
              nodeId, path: `${base}.${key}.fileName`, label, inputOrder, enabled: true, detectedBinding: true });
          }
          (timeline.refImages || []).forEach((ref, index) => {
            if (typeof ref?.fileName === "string") bindings.push({ kind: "image", mode: "director",
              nodeId, path: `${base}.refImages.${index}.fileName`, label: `导演台分段参考图 ${index + 1}`,
              inputOrder: index, enabled: true, detectedBinding: true });
          });
          for (const [key, semantic, label] of [
            ["settings.executionScope", "switch", "分段运行范围"], ["settings.startSegment", "segment_index", "起始分段"],
            ["settings.snapToCuts", "switch", "吸附切点"], ["resume.enabled", "switch", "启用断点续跑"]
          ]) {
            const path = `${base}.${key}`;
            try {
              const value = readInput(w, nodeId, path);
              if (scalar(value)) addParameter(nodeId, path, value,
                { semantic, tier: "primary" },
                key === "settings.executionScope" ? { options: ["start_to_end", "single_segment"] } :
                  semantic === "segment_index" ? { type: "INT", min: 1, max: Math.max(1, timeline.segments?.length || 1), step: 1 } : {},
                { label, groupKey: `director:${nodeId}`, groupLabel: "导演台与分段",
                  ...(key === "settings.executionScope" ? { optionLabels: { start_to_end: "从起始分段运行到结尾", single_segment: "仅运行当前分段" } } : {}) });
            } catch { /* Missing optional timeline settings stay absent. */ }
          }
          diagnostics.push(`节点 ${nodeId}：保留 ${timeline.segments?.length || 0} 段时间轴和蒙版；视频依次绑定原视频、蒙版视频。新素材须匹配已有分段范围，重新绘制蒙版仍需在 ComfyUI 导演台完成。`);
        } else diagnostics.push(`节点 ${nodeId}：导演台时间轴 JSON 无效，无法识别内嵌素材入口。`);
      }
      // Only supported reference banks are expanded. Unknown graph structures stay fixed.
      for (const [path, definition] of Object.entries(schema)) {
        const s = spec(definition), t = s.template;
        if (s.type !== "COMFY_AUTOGROW_V3" || !t?.prefix || !Number.isFinite(t.max)) continue;
        const ref = Object.values(t.input?.required || {})[0]?.[0];
        const kind = /ref_image/.test(t.prefix) ? "image" : /ref_video_audio/.test(t.prefix) ? null :
          /ref_video/.test(t.prefix) ? "video" : /ref_audio/.test(t.prefix) ? "audio" : null;
        if (kind && ["IMAGE", "AUDIO"].includes(ref)) bindings.push({
          kind, mode: "slots", nodeId, path: `${path}.${t.prefix}`, label: node._meta?.title || node.class_type,
          enabled: true, capacity: t.max, max: isH3ReferenceNode(node, infos) ? Math.min(h3ReferenceLimits[kind], t.max) :
            kind === "video" ? Math.min(1, t.max) : t.max,
          companion: kind === "video" && schema.ref_video_audios ? "ref_video_audios.ref_video_audio_" : undefined
        });
      }
      for (const [prefix, kind] of [["ref_image_", "image"], ["ref_audio_", "audio"], ["ref_video_", "video"]]) {
        const keys = Object.keys(schema).filter(k => new RegExp(`^${prefix}\\d+$`).test(k));
        if (keys.length) bindings.push({
          kind, mode: "slots", nodeId, path: prefix, label: node._meta?.title || node.class_type,
          enabled: true, capacity: keys.length, max: isH3ReferenceNode(node, infos) ? Math.min(h3ReferenceLimits[kind], keys.length) :
            kind === "video" ? 1 : keys.length,
          companion: kind === "video" && schema.ref_video_audio_0 ? "ref_video_audio_" : undefined
        });
      }
    }
    // Loader files upstream of a multi-reference bank belong to that bank, not extra slots.
    const bankLoaders = new Set();
    for (const b of bindings.filter(b => b.mode === "slots")) {
      for (const [path, link] of Object.entries(w[b.nodeId].inputs)) {
        if (path.startsWith(b.path) && isLink(link, w)) {
          try { const trail = mediaTrail(w, link, b.kind, infos); bankLoaders.add(trail.at(-1).nodeId); } catch { /* retain unresolved loader for manual mapping */ }
        }
      }
    }
    const cleaned = bindings.filter(b => b.kind === "text" || b.mode === "slots" || !bankLoaders.has(b.nodeId))
      .map(b => ({ ...b, id: bindingId(b) })).sort((a, b) =>
        ["text", "image", "audio", "video"].indexOf(a.kind) - ["text", "image", "audio", "video"].indexOf(b.kind) ||
        a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }) ||
        (a.inputOrder ?? 0) - (b.inputOrder ?? 0) || a.path.localeCompare(b.path));
    return {
      parameters: sortParameters(parameters),
      bindings: cleaned,
      outputs,
      diagnostics: [...new Set(diagnostics)]
    };
  }
  function updatedLabel(old, detected) {
    return !old.label || old.label === old.detectedLabel || old.label === (fields[detected.semantic] || detected.semantic)
      ? detected.label : old.label;
  }
  function prepareParameters(w, definitions) {
    const detected = new Map(detect(w, {}, { includeAdvanced: true }).parameters.map(p => [`${p.nodeId}:${p.path}`, p]));
    return definitions.map(old => {
      const p = detected.get(`${old.nodeId}:${old.path}`);
      const automatic = Boolean(old.detectedType || old.key?.startsWith("auto_"));
      if (!p) return { ...old, groupKey: `other:${old.nodeId}`, category: 5, groupOrder: 0, order: 0,
        tier: automatic ? "advanced" : "primary", ...(automatic && old.visible === undefined ? { visible: false } : {}) };
      const result = { ...old, label: updatedLabel(old, p), detectedLabel: p.detectedLabel, semantic: p.semantic,
        groupKey: p.groupKey, groupLabel: p.groupLabel, groupOrder: p.groupOrder, order: p.order,
        category: p.category, loraParameter: p.loraParameter, optionLabels: p.optionLabels,
        booleanLabels: p.booleanLabels, tier: automatic ? p.tier : "primary",
        ...(automatic && p.tier === "advanced" && old.visible === undefined ? { visible: false } : {}) };
      if (p.loraParameter && p.semantic === "lora_name") {
        result.options = [NONE_OPTION, ...new Set((old.options?.length ? old.options : p.options || [])
          .filter(v => scalar(v) && !noLora(v)))];
        result.type = "enum";
        if (noLora(result.defaultValue)) result.defaultValue = NONE_OPTION;
      }
      return result;
    });
  }
  function mergeDetection(previous, detected, ignored = [], id = p => `${p.nodeId}:${p.path}`) {
    const map = new Map(previous.map(p => [id(p), p]));
    for (const p of detected) {
      const old = map.get(id(p));
      if (!old && !ignored.includes(id(p))) map.set(id(p), p);
      else if (old?.detectedType || old?.detectedBinding) {
        const merged = { ...p, ...old, options: p.options, min: p.min, max: p.max, step: p.step,
          type: old.type === old.detectedType ? p.type : old.type, detectedType: p.detectedType,
          detectedLabel: p.detectedLabel, groupKey: p.groupKey, groupLabel: p.groupLabel,
          groupOrder: p.groupOrder, order: p.order, category: p.category, semantic: p.semantic, loraParameter: p.loraParameter,
          optionLabels: p.optionLabels, booleanLabels: p.booleanLabels,
          tier: p.tier };
        merged.label = updatedLabel(old, p);
        if (p.detectedBinding && old.detectedBinding) merged.enabled = old.enabled;
        map.set(id(p), merged);
      }
    }
    return [...map.values()];
  }
  function bypassLoras(w, disabled, infos) {
    const nativePorts = {
      LoraLoader: ["model", "clip"], LoraLoaderModelOnly: ["model"],
      LoraLoaderBypass: ["model", "clip"], LoraLoaderBypassModelOnly: ["model"]
    };
    const routes = new Map();
    for (const nodeId of disabled) {
      const node = w[nodeId], info = infos[node.class_type];
      const ports = nativePorts[node.class_type];
      let replacements;
      if (ports) replacements = ports.map(path => node.inputs[path]);
      else {
        const choices = spec(schemaFields(info).lora_name).options;
        const nativeNone = choices?.find(noLora);
        if (nativeNone !== undefined) { node.inputs.lora_name = nativeNone; continue; }
        if (!info?.output?.length || info.output_node ||
            info.output.some(type => !["MODEL", "CLIP"].includes(type))) {
          throw new Error(`LoRA ${nodeId}（${node.class_type}）无法安全停用：需提供 MODEL/CLIP 输入输出定义或原生 none 选项`);
        }
        const inputs = schemaFields(info);
        replacements = info.output.map(type => {
          const candidates = Object.entries(inputs).filter(([path, definition]) =>
            spec(definition).type === type && isLink(node.inputs[path], w));
          if (candidates.length !== 1) throw new Error(`LoRA ${nodeId} 的 ${type} 上游不唯一，无法安全停用`);
          return node.inputs[candidates[0][0]];
        });
      }
      routes.set(nodeId, replacements);
    }
    function resolve(link, seen = new Set()) {
      const nodeId = String(link[0]);
      if (!routes.has(nodeId)) return [...link];
      if (seen.has(nodeId)) throw new Error(`LoRA ${nodeId} 的旁路连线存在循环`);
      const replacement = routes.get(nodeId)[link[1]];
      if (!isLink(replacement, w)) throw new Error(`LoRA ${nodeId} 的输出端口 ${link[1]} 缺少兼容的上游，无法安全停用`);
      return resolve(replacement, new Set([...seen, nodeId]));
    }
    function rewrite(value) {
      if (isLink(value, w)) return resolve(value);
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
      return value;
    }
    // Resolve all disabled chains before deleting nodes, including nested custom inputs.
    const rewritten = new Map(Object.entries(w).filter(([id]) => !routes.has(id))
      .map(([id, node]) => [id, rewrite(node.inputs)]));
    for (const [id, inputs] of rewritten) w[id].inputs = inputs;
    for (const id of routes.keys()) delete w[id];
  }
  function applyParameters(w, defs, values, infos = {}) {
    const keys = new Set();
    const disabledLoras = new Set();
    for (const d of defs) {
      if (d.path !== "lora_name") continue;
      const raw = own(values, d.key) ? values[d.key] : d.defaultValue;
      if (noLora(raw)) disabledLoras.add(String(d.nodeId));
    }
    for (const d of defs) {
      if (!d.nodeId || !d.path) throw new Error(`参数“${d.label}”的节点 ID / 字段未填写`);
      if (!d.key || keys.has(d.key) || !safe(d.key)) throw new Error(`参数键重复或不合法：${d.key}`);
      keys.add(d.key);
      const raw = own(values, d.key) ? values[d.key] : d.defaultValue;
      if (raw === undefined) continue;
      const current = readInput(w, d.nodeId, d.path);
      if (disabledLoras.has(String(d.nodeId)) && /^strength_(?:model|clip)$/.test(d.path)) continue;
      if (isLink(current, w)) throw new Error(`参数“${d.label}”指向连线，请绑定上游常量`);
      if (d.path === "lora_name" && noLora(raw)) continue;
      if (d.type === "enum" && d.options?.length && !d.options.includes(raw) &&
          !(modelField(d.path) && spec(schemaFields(infos[w[d.nodeId].class_type])[d.path]).options))
        throw new Error(`参数“${d.label}”不是有效选项`);
      let v = raw;
      if (d.type === "number") {
        if (raw === "" || raw === null || typeof raw === "boolean") throw new Error(`参数“${d.label}”需要数字`);
        v = Number(raw);
        if (!Number.isFinite(v) || d.integer && !Number.isSafeInteger(v)) throw new Error(`参数“${d.label}”不是有效${d.integer ? "整数" : "数字"}`);
        if (d.min !== undefined && v < d.min || d.max !== undefined && v > d.max) throw new Error(`参数“${d.label}”超出范围 ${d.min ?? ""} ~ ${d.max ?? ""}`);
      } else if (d.type === "boolean") {
        if (typeof raw !== "boolean") throw new Error(`参数“${d.label}”需要开关值`);
      } else if (d.type !== "enum") v = String(raw);
      writeInput(w, d.nodeId, d.path, v);
      if (w[d.nodeId].class_type === "WatermarkRemovalDirector" && d.path === "frame_rate") {
        const timeline = parsedSettings(w[d.nodeId].inputs.timeline_data);
        if (timeline && own(timeline, "frameRate")) writeInput(w, d.nodeId, "timeline_data.frameRate", v);
      }
    }
    if (disabledLoras.size) bypassLoras(w, disabledLoras, infos);
    return w;
  }
  function edgeKey(e) { return encodeURIComponent(JSON.stringify([e.source, e.sourceHandle])); }
  function orderedEdges(nodes, edges, id) {
    const order = nodes.find(n => n.id === id)?.data?.referenceOrder?.in || [];
    const ranks = new Map(order.map((k, i) => [k, i]));
    return edges.filter(e => e.target === id && (!e.targetHandle || e.targetHandle === "in"))
      .sort((a, b) => (ranks.get(edgeKey(a)) ?? order.length) - (ranks.get(edgeKey(b)) ?? order.length));
  }
  function collectCanvas(nodes, edges, id) {
    const lookup = new Map(nodes.map(n => [n.id, n]));
    function expand(node, handle, seen = new Set()) {
      if (!node || seen.has(node.id)) return [];
      seen.add(node.id);
      const results = [];
      function push(out, index = "") {
        if (Array.isArray(out)) { out.forEach((v, i) => push(v, `${index}/${i}`)); return; }
        if (!out || typeof out !== "object") return;
        const type = out.dataType;
        if (Array.isArray(out.value)) { out.value.forEach((v, i) => push(v?.dataType ? v : { dataType: type, value: v }, `${index}/${i}`)); return; }
        const kind = kinds[type] || (type === "STRING" ? "text" : "");
        const value = out.value;
        if (!kind) return;
        if (kind === "text" && typeof value !== "string") return;
        const url = value?.url || (typeof value === "string" ? value : "");
        if (kind !== "text" && !url) return;
        results.push({ kind, text: kind === "text" ? value : undefined, url: kind !== "text" ? url : undefined,
          key: kind === "text" ? `${node.id}:${handle}${index}` : `${kind}:${url}`, source: node.id, handle,
          label: node.data?.label || names[kind], mimeType: value?.mimeType });
      }
      // The native text composer updates prompt before it updates the saved text output.
      const prompt = node.data?.prompt;
      if (/^(?:remote-)?textNode$/.test(node.type || "") && handle === "text" &&
          typeof prompt === "string" && prompt.trim()) {
        push({ dataType: "STRING", value: prompt });
      } else push(node.data?.outputs?.[handle]);
      if (!results.length) {
        for (const child of nodes.filter(n => (n.parentNode || n.parentId) === node.id)) {
          for (const port of Object.keys(child.data?.outputs || {})) results.push(...expand(child, port, new Set(seen)));
          if (!Object.keys(child.data?.outputs || {}).length) results.push(...expand(child, "", new Set(seen)));
        }
      }
      return results;
    }
    const refsFor = nodeId => orderedEdges(nodes, edges, nodeId).flatMap(e => expand(lookup.get(e.source), e.sourceHandle));
    const direct = refsFor(id);
    const texts = direct.filter(r => r.kind === "text").map(r => ({ ...r, scope: refsFor(r.source) }));
    const all = [...direct, ...texts.flatMap(r => r.scope)].filter(r => r.kind !== "text");
    const gallery = [...new Map(all.map(r => [r.key, r])).values()];
    const counters = { image: 0, audio: 0, video: 0 };
    gallery.forEach(r => { r.alias = `${names[r.kind]}${++counters[r.kind]}`; });
    return { gallery, texts, direct };
  }
  function referenceToken(key) { return `{{tfref:${encodeURIComponent(key)}}}`; }
  function promptSegments(text) {
    const parts = [], pattern = /\{\{tfref:([^}]+)\}\}/g;
    let start = 0;
    for (const match of String(text).matchAll(pattern)) {
      if (match.index > start) parts.push({ text: text.slice(start, match.index) });
      try { parts.push({ key: decodeURIComponent(match[1]) }); }
      catch { parts.push({ text: match[0] }); }
      start = match.index + match[0].length;
    }
    if (start < text.length) parts.push({ text: text.slice(start) });
    return parts;
  }
  function selectReferences(canvas, mode = "mentioned", nodePrompt = "", { allowEmpty = false } = {}) {
    const selected = [], seen = new Set();
    function add(r) {
      if (!seen.has(r.key)) { selected.push(r); seen.add(r.key); }
      return `@@TFREF${selected.findIndex(s => s.key === r.key)}@@`;
    }
    const aliases = new Map();
    for (const r of canvas.gallery) {
      for (const label of new Set([r.alias, r.label])) {
        if (!aliases.has(label)) aliases.set(label, []);
        aliases.get(label).push(r);
      }
    }
    function byName(label) {
      const matches = aliases.get(label) || [];
      if (matches.length !== 1) throw new Error(`@${label} ${matches.length ? "名称重复，请用图片/音频/视频编号" : "没有对应的画布连线素材"}`);
      return add(matches[0]);
    }
    function resolve(text, scope, depth = 0) {
      if (depth > 12) throw new Error("文字引用循环或层级过深");
      let v = text.replace(/\{\{tfref:([^}]+)\}\}/g, (_, encoded) => {
        let key;
        try { key = decodeURIComponent(encoded); } catch { throw new Error("素材引用标记损坏，请重新选择素材"); }
        const r = canvas.gallery.find(item => item.key === key);
        if (!r) throw new Error("提示词中的参考素材已断开或已更换，请重新连接并选择素材");
        return add(r);
      });
      v = v.replace(/\{\{ref\s+(\d+)\}\}/g, (_, n) => {
        const r = scope[Number(n) - 1];
        if (!r) throw new Error(`参考 ${n} 已断开，无法解析 @ 引用`);
        if (r.kind === "text") return resolve(r.text, [], depth + 1);
        return add(r);
      });
      v = v.replace(/@\{([^}]+)\}/g, (_, label) => byName(label));
      v = v.replace(/@(图片|图像|音频|视频|参考)\s*(\d+)/g, (_, kind, n) => {
        if (kind === "参考") {
          const r = scope[Number(n) - 1];
          if (!r || r.kind === "text") throw new Error(`参考 ${n} 不是可用媒体`);
          return add(r);
        }
        return byName(`${kind === "图像" ? "图片" : kind}${n}`);
      });
      // Named mentions are exact and boundary-delimited; email addresses are untouched.
      for (const label of [...aliases.keys()].sort((a, b) => b.length - a.length)) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        v = v.replace(new RegExp(`(^|[\\s，。；、（(])@${escaped}(?=$|[\\s，。；、）)！!?])`, "g"), (_, lead) => lead + byName(label));
      }
      if (/\{\{tfref:|@(?:图片|图像|音频|视频|参考)|@\{|(?:^|\s)@[^\s，。；、]+/.test(v.replace(/@@TFREF\d+@@/g, ""))) throw new Error("存在未解析的 @ 素材引用");
      return v;
    }
    const local = typeof nodePrompt === "string" && nodePrompt.trim();
    const text = local ? resolve(nodePrompt, canvas.gallery) : canvas.texts.map(t => {
      const resolved = resolve(t.text, t.scope.length ? t.scope : canvas.direct);
      // A text node's connected attachments are implicit unless its prompt selects a subset.
      if (!/@@TFREF\d+@@/.test(resolved)) t.scope.filter(r => r.kind !== "text").forEach(add);
      return resolved;
    }).join("\n");
    if (local && !/@@TFREF\d+@@/.test(text)) canvas.gallery.forEach(add);
    if (mode === "all") canvas.gallery.forEach(add);
    if (!allowEmpty && mode === "mentioned" && canvas.gallery.length && !selected.length) throw new Error("已连接参考素材，但提示词中没有 @ 引用；请在节点或文字节点填写提示词、选择参考素材，或切换为全部连线");
    const counters = { image: 0, audio: 0, video: 0 };
    const numbered = selected.map(r => ({ ...r, index: ++counters[r.kind] }));
    return { selected: numbered, text, counts: counters,
      renderText(h3, audioOffset = 0) { return text.replace(/@@TFREF(\d+)@@/g, (_, n) => {
        const r = numbered[Number(n)];
        return h3 ? `<${{ image: "Picture", audio: "Audio", video: "Video" }[r.kind]} ${r.index + (r.kind === "audio" ? audioOffset : 0)}>` : `${names[r.kind]}${r.index}`;
      }); } };
  }
  function canvasPrompt(canvas) {
    const selection = selectReferences(canvas, "mentioned", "", { allowEmpty: true });
    const explicit = new Set();
    const text = selection.text.replace(/@@TFREF(\d+)@@/g, (_, n) => {
      const key = selection.selected[Number(n)].key;
      explicit.add(key);
      return referenceToken(key);
    });
    const attachments = selection.selected.filter(r => !explicit.has(r.key)).map(r => referenceToken(r.key));
    return attachments.length ? [text, attachments.join(" ")].filter(Boolean).join("\n") : text;
  }
  function validateBindings(w, bindings, selection) {
    const enabled = bindings.filter(b => b.enabled !== false);
    if (selection.text.trim() && !enabled.some(b => b.kind === "text")) throw new Error("工作流尚未绑定提示词入口，请先一键检测并确认提示词绑定");
    for (const b of enabled) {
      if (b.mode !== "slots") readInput(w, b.nodeId, b.path);
      else if (!own(w, b.nodeId) || !safe(b.path) || !/^[\w.]+_$/.test(b.path) ||
        !Number.isInteger(Number(b.max)) || Number(b.max) < 0 || Number(b.max) > b.capacity) throw new Error("参考素材槽位或数量上限不合法");
    }
    for (const kind of ["image", "audio", "video"]) {
      const bs = enabled.filter(b => b.kind === kind), slots = bs.filter(b => ["slots", "list"].includes(b.mode));
      for (const b of slots) if (!Number.isInteger(Number(b.max)) || Number(b.max) < 0 ||
        !Number.isInteger(b.capacity) || Number(b.max) > b.capacity) throw new Error("参考素材数量上限不合法");
      const count = selection.counts[kind];
      if (isH3ReferenceWorkflow(w) && count > h3ReferenceLimits[kind])
        throw new Error(`MiniMax H3 ${names[kind]}引用 ${count} 个，上限 ${h3ReferenceLimits[kind]} 个；请删减参考连线或提示词中的 @ 引用`);
      const capacity = slots.length ? Math.min(...slots.map(b => {
        const value = b.mode === "list" && b.detectedMax === Number(b.max) ? Number(w[b.nodeId].inputs.max_images) : Number(b.max);
        return Math.min(value > 0 ? value : b.mode === "list" && value === 0 ? b.capacity : 0, b.capacity);
      })) : bs.length;
      if (count > capacity) throw new Error(`${names[kind]}引用 ${count} 个，当前工作流上限 ${capacity || 0} 个；请删减参考连线或提示词中的 @ 引用，或配置对应入口`);
    }
    return enabled;
  }
  function mediaTrail(w, link, kind, infos, seen = new Set()) {
    if (!isLink(link, w) || seen.has(String(link[0]))) throw new Error("素材入口不是可识别的加载链");
    const id = String(link[0]), node = w[id]; seen.add(id);
    const defs = schemaFields(infos[node.class_type]);
    const file = Object.keys(node.inputs).find(p => fileKind(node.class_type, p, defs[p]) === kind);
    if (file) return [{ nodeId: id, file, output: link[1] }];
    const candidates = Object.entries(node.inputs).filter(([p, v]) => isLink(v, w) &&
      (/image|video|audio|frames|pixels/i.test(p) || kinds[spec(defs[p]).type] === kind));
    if (candidates.length !== 1) throw new Error(`节点 ${id} 的素材处理链无法自动识别`);
    const [path, next] = candidates[0];
    return [{ nodeId: id, path, output: link[1] }, ...mediaTrail(w, next, kind, infos, seen)];
  }
  function loaderFor(kind, infos) {
    const preferred = kind === "image" ? ["LoadImage"] : kind === "audio" ? ["LoadAudio", "LoadAudioUI"] : ["LoadVideoUI", "VHS_LoadVideo"];
    for (const type of preferred) {
      const s = infos[type]; if (!s) continue;
      const schema = schemaFields(s), path = Object.keys(schema).find(p => fileKind(type, p, schema[p]) === kind);
      const outputType = kind === "video" ? "IMAGE" : kind.toUpperCase();
      const output = s.output?.indexOf(outputType);
      if (!path || !(output >= 0)) continue;
      const inputs = {}; let valid = true;
      for (const [p, definition] of Object.entries(s.input?.required || {})) {
        if (p === path) { inputs[p] = ""; continue; }
        const d = spec(definition);
        if (d.default !== undefined) inputs[p] = d.default;
        else if (d.options?.length) inputs[p] = d.options[0];
        else { valid = false; break; }
      }
      if (valid) return { type, path, output, inputs, audioOutput: s.output?.indexOf("AUDIO") };
    }
    throw new Error(`本地 ComfyUI 缺少可自动绑定的${names[kind]}加载器`);
  }
  function bankKeys(inputs, prefix) {
    return Object.keys(inputs).filter(p => p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  }
  function normalizeH3Bindings(w, bindings, infos = {}) {
    if (!isH3ReferenceWorkflow(w, infos)) return bindings;
    const banks = detect(w, infos).bindings.filter(b => b.mode === "slots" && isH3ReferenceNode(w[b.nodeId], infos));
    const replacedFiles = new Set();
    for (const b of banks) for (const path of bankKeys(w[b.nodeId].inputs, b.path)) {
      try {
        const loader = mediaTrail(w, w[b.nodeId].inputs[path], b.kind, infos).at(-1);
        replacedFiles.add(bindingId({ kind: b.kind, nodeId: loader.nodeId, path: loader.file }));
      } catch { /* Unresolved chains still fail in the graph preflight. */ }
    }
    for (const b of banks.filter(b => b.companion)) for (const path of bankKeys(w[b.nodeId].inputs, b.companion)) {
      try {
        const loader = mediaTrail(w, w[b.nodeId].inputs[path], "audio", infos).at(-1);
        replacedFiles.add(bindingId({ kind: "audio", nodeId: loader.nodeId, path: loader.file }));
      } catch { /* A video loader's own soundtrack is already covered by its video bank. */ }
    }
    const normalized = bindings.filter(b => !replacedFiles.has(bindingId(b))).map(b => ({ ...b }));
    for (const bank of banks) {
      const index = normalized.findIndex(b => bindingId(b) === bindingId(bank));
      const old = index >= 0 ? normalized[index] : {};
      const updated = { ...bank, ...old, capacity: bank.capacity,
        max: Math.min(Number(old.max ?? bank.max), bank.max), companion: bank.companion };
      if (index >= 0) normalized[index] = updated;
      else normalized.push(updated);
    }
    // Old H3 imports may have no detected prompt binding. Bind the real prompt field.
    if (!normalized.some(b => b.kind === "text")) {
      for (const [nodeId, node] of Object.entries(w)) if (isH3ReferenceNode(node, infos) && own(node.inputs, "prompt"))
        normalized.push({ kind: "text", mode: "file", nodeId, path: "prompt", enabled: true, label: node.class_type });
    }
    return normalized;
  }
  function renderPrompt(w, selection, infos = {}) {
    const nodes = Object.values(w).filter(node => isH3ReferenceNode(node, infos));
    // H3 numbers video soundtracks before standalone audio references.
    const offsets = new Set(nodes.map(node => bankKeys(node.inputs, "ref_video_audios.ref_video_audio_")
      .concat(bankKeys(node.inputs, "ref_video_audio_")).filter(path => {
        const index = path.match(/(\d+)$/)[1];
        return own(node.inputs, `ref_videos.ref_video_${index}`) || own(node.inputs, `ref_video_${index}`);
      }).length));
    if (selection.counts.audio && offsets.size > 1) throw new Error("多个 H3 节点的视频原声数量不同，无法统一音频引用编号；请拆分工作流");
    return selection.renderText(nodes.length > 0, selection.counts.audio ? [...offsets][0] || 0 : 0);
  }
  function applyCanvas(w, bindings, selection, uploads, infos = {}, mediaInfo) {
    const normalized = normalizeH3Bindings(w, bindings, infos);
    const enabled = validateBindings(w, normalized, selection);
    let next = Math.max(0, ...Object.keys(w).map(k => Number(k)).filter(Number.isFinite)) + 1;
    const newId = () => { while (own(w, String(next))) next++; return String(next++); };
    const abandoned = new Set();
    for (const kind of ["image", "audio", "video"]) {
      const refs = selection.selected.filter(r => r.kind === kind);
      const bs = enabled.filter(b => b.kind === kind);
      const banks = normalized.filter(b => b.kind === kind && b.mode === "slots" &&
        (b.enabled !== false || isH3ReferenceNode(w[b.nodeId], infos)));
      if (!banks.length) {
        const lists = bs.filter(b => b.mode === "list");
        if (lists.length) {
          if (bs.length !== lists.length) throw new Error(`${names[kind]}同时存在批量与单文件入口，请在管理中只启用实际使用的一组入口`);
          if (refs.length) for (const b of lists) writeInput(w, b.nodeId, b.path, refs.map(r => uploads[r.key]).join(b.separator || "\n"));
          continue;
        }
        refs.forEach((r, i) => {
          const b = bs[i];
          if (b.mode === "director" && kind === "video") {
            const data = mediaInfo?.[r.key];
            const base = b.path.slice(0, -".fileName".length);
            if (mediaInfo && (!data || !Number.isInteger(data.frame_count) || data.frame_count < 1 ||
                !Number.isFinite(data.fps) || data.fps <= 0 || !(data.width > 0) || !(data.height > 0)))
              throw new Error(`${b.label}未取得有效的新视频帧数与尺寸，工作流未提交`);
            if (data) {
              const timeline = parsedSettings(w[b.nodeId].inputs.timeline_data);
              const end = Math.max(0, ...timeline.segments.map(s => Number(s.end) || 0));
              const old = readInput(w, b.nodeId, base);
              if (Number(old.trimStart || 0) + end > data.frame_count)
                throw new Error(`${b.label}帧数不足以覆盖已保存分段，请在 ComfyUI 导演台重新设置时间轴与蒙版`);
              if (old.sourceFps && Math.abs(old.sourceFps - data.fps) > 0.01)
                throw new Error(`${b.label}帧率与已保存分段不同，请在 ComfyUI 导演台重新校准时间轴`);
              const replacement = { ...old, fileName: uploads[r.key], path: "", file: "", filename: "", video: "",
                sourceFps: data.fps, fps: data.fps, width: data.width, height: data.height,
                totalFrames: data.frame_count, trimEnd: Math.min(Number(old.trimEnd || data.frame_count), data.frame_count) };
              delete replacement.peaks;
              delete replacement.audioPeaksSource;
              writeInput(w, b.nodeId, base, replacement);
              return;
            }
          }
          writeInput(w, b.nodeId, b.path, uploads[r.key]);
          if (b.mode === "director") {
            const base = b.path.slice(0, -".fileName".length);
            const ref = readInput(w, b.nodeId, base);
            for (const key of ["path", "file", "filename", "video"]) if (own(ref, key)) writeInput(w, b.nodeId, `${base}.${key}`, "");
          }
        });
        // Never leave unselected imported reference files executing silently.
        if (refs.length < bs.length && (refs.length || selection.text.trim()) &&
            !(refs.length === 0 && bs.every(b => b.mode === "director")))
          throw new Error(`${names[kind]}是固定 ${bs.length} 个入口的工作流，不能自动减少到 ${refs.length} 个；请删减绑定及工作流，或改为可变参考槽位`);
        continue;
      }
      for (const b of banks) {
        const input = w[b.nodeId].inputs;
        const keys = bankKeys(input, b.path);
        const templates = keys.map(p => input[p]);
        const trails = templates.map(link => mediaTrail(w, link, kind, infos));
        trails.forEach(t => t.forEach(n => abandoned.add(n.nodeId)));
        keys.forEach(p => delete input[p]);
        if (b.companion) bankKeys(input, b.companion).forEach(p => {
          const link = input[p];
          if (isLink(link, w) && !abandoned.has(String(link[0])))
            mediaTrail(w, link, "audio", infos).forEach(n => abandoned.add(n.nodeId));
          delete input[p];
        });
        (b.enabled === false ? [] : refs).forEach((r, i) => {
          let link, audio;
          const trail = trails[i] || trails[0];
          if (trail) {
            let downstream;
            // Clone only the media processing chain, keeping model / size dependencies unchanged.
            for (const item of [...trail].reverse()) {
              const id = newId(), n = clone(w[item.nodeId]);
              if (item.file) n.inputs[item.file] = uploads[r.key];
              else n.inputs[item.path] = downstream;
              w[id] = n; downstream = [id, item.output];
              if (item.file && kind === "video") {
                const ai = infos[n.class_type]?.output?.indexOf("AUDIO");
                if (ai >= 0) audio = [id, ai];
              }
            }
            link = downstream;
          } else {
            const loader = loaderFor(kind, infos), id = newId();
            w[id] = { class_type: loader.type, inputs: { ...loader.inputs, [loader.path]: uploads[r.key] } };
            link = [id, loader.output];
            if (loader.audioOutput >= 0) audio = [id, loader.audioOutput];
          }
          input[b.path + i] = link;
          if (b.companion && audio) input[b.companion + i] = audio;
        });
      }
    }
    for (const b of enabled.filter(b => b.kind === "text")) if (selection.text.trim())
      writeInput(w, b.nodeId, b.path, renderPrompt(w, selection, infos));
    // Old banks may feed preview-only branches. Remove those too, but reject shared live branches.
    const removable = new Set(abandoned);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, n] of Object.entries(w)) if (/^Preview/.test(n.class_type) &&
          Object.values(n.inputs).some(v => isLink(v, w) && removable.has(String(v[0]))) && !removable.has(id)) {
        removable.add(id); changed = true;
      }
    }
    for (const [id, n] of Object.entries(w)) if (!removable.has(id) &&
      Object.values(n.inputs).some(v => isLink(v, w) && removable.has(String(v[0])))) {
      throw new Error(`原参考素材还被节点 ${id} 共用，不能自动剔除；请拆分共用分支后重试`);
    }
    for (const id of removable) delete w[id];
    return w;
  }
  return { parseWorkflow, formatNodeErrors, fillRequiredDefaults, validateRequiredInputs, resolveModelFiles, modelField, executionNodeIds,
    readInput, writeInput, isLink, detect, detectOutputs, prepareParameters, sortParameters, mergeDetection, applyParameters,
    collectCanvas, selectReferences, referenceToken, promptSegments, canvasPrompt,
    validateBindings, normalizeH3Bindings, isH3ReferenceWorkflow, renderPrompt,
    applyCanvas, mediaTrail, loaderFor, bindingId, clone, names, noneOption: NONE_OPTION };
}

function createExecutionProgress(workflow, infos = {}) {
  const expected = new Set(), states = new Map();
  const outputs = Object.keys(workflow).filter(id => infos[workflow[id].class_type]?.output_node === true);
  function visit(id) {
    if (expected.has(id) || !Object.hasOwn(workflow, id)) return;
    expected.add(id);
    for (const value of Object.values(workflow[id].inputs || {}))
      if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1]) &&
          Object.hasOwn(workflow, String(value[0]))) visit(String(value[0]));
  }
  (outputs.length ? outputs : Object.keys(workflow)).forEach(visit);
  let current = "", percent = 0, detailed = false, legacyOwner = false;
  let stage = "等待运行", note = "任务已提交";
  function identity(entry) {
    const id = String(entry.node_id ?? entry.node ?? "");
    const candidates = [id, entry.display_node_id, entry.display_node, entry.real_node_id, entry.parent_node_id];
    const base = candidates.find(value => value != null && Object.hasOwn(workflow, String(value)));
    return { id, base: base == null ? id : String(base) };
  }
  function store(entry, state = entry.state) {
    const { id, base } = identity(entry);
    if (!id) return;
    const old = states.get(id);
    const valid = Number.isFinite(entry.value) && Number.isFinite(entry.max) && entry.max > 0;
    const ratio = state === "finished" ? 1 :
      valid ? Math.min(1, Math.max(0, entry.value / entry.max)) : old?.ratio;
    states.set(id, { ...old, id, base: Object.hasOwn(workflow, base) ? base : old?.base || base, state, ratio,
      value: state === "finished" ? (valid ? entry.max : old?.max) :
        valid ? entry.value : old?.value, max: valid ? entry.max : old?.max });
    if (Object.hasOwn(workflow, base)) expected.add(base);
    if (state === "running" || state === "error") current = id;
    return id;
  }
  function snapshot() {
    const groups = new Map();
    for (const item of states.values()) {
      if (!expected.has(item.base)) continue;
      const group = groups.get(item.base) || [];
      group.push(item); groups.set(item.base, group);
    }
    let done = 0, units = 0;
    for (const group of groups.values()) {
      const complete = group.every(item => item.state === "finished");
      if (complete) { done++; units++; }
      else units += group.reduce((sum, item) => sum + (item.state === "finished" ? 1 : item.ratio || 0), 0) / group.length;
    }
    percent = Math.max(percent, Math.min(99, Math.floor(units / Math.max(1, expected.size) * 100)));
    const active = [...states.values()].filter(item => item.state === "running");
    const item = states.get(current);
    const node = item && workflow[item.base];
    const title = node?._meta?.title || infos[node?.class_type]?.display_name || node?.class_type || "动态节点";
    const stateNames = { running: "正在运行", finished: "已完成", error: "执行失败" };
    const nodeSummary = item ? `节点 ${item.id} · ${title} · ${stateNames[item.state] || "等待运行"}` : "";
    const stepPercent = item?.ratio == null ? null : Math.round(item.ratio * 100);
    return { stage, percent, nodeSummary, stepPercent, completed: done, total: expected.size,
      detail: [note, item?.max ? `当前节点 ${stepPercent}% · ${item.value} / ${item.max}` : "",
        active.length > 1 ? `另有 ${active.length - 1} 个节点正在运行` : ""].filter(Boolean).join(" · ") };
  }
  function accept(message, promptId) {
    const d = message?.data;
    if (!d || !promptId) return;
    if (d.prompt_id && d.prompt_id !== promptId) {
      if (message.type === "executing" || message.type === "execution_start") legacyOwner = false;
      return;
    }
    if (message.type === "progress_state") {
      const entries = Object.values(d.nodes || {}).filter(entry => (entry.prompt_id || d.prompt_id) === promptId);
      if (!entries.length) return;
      detailed = true;
      for (const entry of entries) store(entry);
      stage = entries.some(entry => entry.state === "error") ? "执行失败" : "正在运行";
      note = "";
      return snapshot();
    }
    // Older servers omit prompt_id on progress; accept only after a scoped executing event.
    if (!d.prompt_id && !(message.type === "progress" && legacyOwner &&
        (d.node == null || String(d.node) === current))) return;
    switch (message.type) {
      case "execution_start":
        legacyOwner = true; stage = "正在运行"; note = "加载模型与准备素材";
        break;
      case "execution_cached":
        for (const id of d.nodes || []) store({ node: id, value: 1, max: 1 }, "finished");
        note = `已复用 ${d.nodes?.length || 0} 个缓存节点`;
        break;
      case "executing":
        legacyOwner = d.node != null;
        if (!detailed && current && current !== String(d.node)) {
          const previous = states.get(current);
          if (previous?.state === "running") store({ node: current, value: 1, max: 1 }, "finished");
        }
        stage = d.node != null ? "正在运行" : "整理输出";
        note = d.node != null ? "" : "等待输出文件";
        if (d.node != null) store(d, "running");
        break;
      case "progress":
        if (d.node == null && !current) return;
        store({ ...d, node: d.node ?? current }, "running");
        stage = "正在运行"; note = "";
        break;
      case "executed":
        store(d, "finished"); note = "";
        break;
      case "execution_success":
        stage = "整理输出"; note = "执行完成，确认输出文件"; percent = 99; legacyOwner = false;
        break;
      case "execution_error":
        store(d, "error"); stage = "执行失败";
        note = d.exception_message || "等待服务端错误详情"; legacyOwner = false;
        break;
      case "execution_interrupted":
        stage = "已中断"; note = "任务已停止"; legacyOwner = false;
        break;
      default: return;
    }
    return snapshot();
  }
  return { accept, snapshot };
}

async function openExecutionStream({ url, clientId, bridgeUrl = "http://127.0.0.1:18190",
  Socket = globalThis.WebSocket, request, onMessage, onState, activateBridge, pollMs = 300 }) {
  let closed = false, socket, sessionId, cursor = 0, timer, bridgeStarted = false;
  const stream = {
    connected: false, mode: "",
    close() {
      closed = true; stream.connected = false; clearTimeout(timer);
      if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); }
      if (sessionId) post("/close", { sessionId }).catch(() => {});
    }
  };
  function state(value, error) { if (!closed) { stream.connected = value === "connected"; onState(value, error?.message); } }
  function post(path, body) {
    return request(bridgeUrl.replace(/\/$/, "") + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }, 5000);
  }
  async function bridge() {
    if (closed || bridgeStarted) return;
    bridgeStarted = true;
    state("connecting");
    try {
      let result;
      try { result = await post("/open", { baseUrl: url, clientId }); }
      catch (error) {
        if (!activateBridge || closed) throw error;
        await activateBridge();
        if (closed) return;
        result = await post("/open", { baseUrl: url, clientId });
      }
      if (result.service !== "toonflow-comfyui-progress" || result.version !== 1 || !result.sessionId)
        throw new Error("Invalid progress bridge");
      sessionId = result.sessionId;
      if (closed) { post("/close", { sessionId }).catch(() => {}); return; }
      stream.mode = "bridge"; state("connected");
      let failures = 0;
      const poll = async () => {
        if (closed) return;
        try {
          const result = await post("/events", { sessionId, after: cursor });
          if (closed) return;
          for (const event of result.events || []) onMessage(event.message);
          cursor = result.cursor;
          failures = 0;
          if (!result.connected) { state("disconnected"); return; }
          state("connected");
        } catch (error) {
          if (closed) return;
          state("disconnected", error);
          if (++failures >= 3) return;
        }
        timer = setTimeout(poll, pollMs);
      };
      timer = setTimeout(poll, 0);
    } catch (error) { state("disconnected", error); }
  }
  state("connecting");
  let nativeReady = false;
  if (typeof Socket === "function") {
    try {
      const endpoint = new URL(url.replace(/\/$/, "") + "/ws");
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.searchParams.set("clientId", clientId);
      socket = new Socket(endpoint.toString());
      socket.onmessage = event => {
        if (closed || typeof event.data !== "string") return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        onMessage(message);
      };
      nativeReady = await new Promise(resolve => {
        const timeout = setTimeout(() => resolve(false), 1500);
        const settle = ok => { clearTimeout(timeout); resolve(ok); };
        socket.onopen = () => { if (!closed) { stream.mode = "direct"; state("connected"); } settle(true); };
        socket.onerror = socket.onclose = () => {
          settle(false);
          if (nativeReady && !closed) { state("disconnected"); bridge(); }
        };
      });
    } catch { /* Server transport handles origins rejected by native WebSocket. */ }
  }
  if (!nativeReady && !closed) {
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); }
    await bridge();
  }
  return stream;
}

function describeMediaOutputs(entries, baseUrl) {
  const types = {
    png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"],
    webp: ["image", "image/webp"], gif: ["image", "image/gif"], avif: ["image", "image/avif"],
    bmp: ["image", "image/bmp"], apng: ["image", "image/apng"],
    mp4: ["video", "video/mp4"], webm: ["video", "video/webm"], mov: ["video", "video/quicktime"],
    mkv: ["video", "video/x-matroska"], avi: ["video", "video/x-msvideo"],
    wav: ["audio", "audio/wav"], mp3: ["audio", "audio/mpeg"], flac: ["audio", "audio/flac"],
    ogg: ["audio", "audio/ogg"], m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"],
    opus: ["audio", "audio/opus"]
  };
  const unique = new Map();
  for (const entry of entries) {
    const filename = entry.filename;
    if (typeof filename !== "string" || !filename || /[/\\\0]/.test(filename) || /^\.+$/.test(filename)) continue;
    const type = types[filename.split(".").pop().toLowerCase()];
    if (!type) continue;
    const [kind, mimeType] = type;
    const storage = entry.type || "output", subfolder = entry.subfolder || "";
    const key = JSON.stringify([storage, subfolder, filename]);
    if (unique.has(key)) continue;
    const query = new URLSearchParams({ filename, subfolder, type: storage });
    unique.set(key, { key, kind, mimeType, filename, storage, subfolder,
      url: `${baseUrl.replace(/\/+$/, "")}/view?${query}` });
  }
  const media = [...unique.values()];
  // Save and preview nodes often report the same result at different resolutions.
  const savedKinds = new Set(media.filter(item => item.storage === "output").map(item => item.kind));
  return media.filter(item => item.storage !== "temp" || !savedKinds.has(item.kind));
}

function mediaResultEdges(source, nodes, edges) {
  return edges.filter(edge => {
    if (edge.source !== source.id || !["image", "video", "audio"].includes(edge.sourceHandle)) return false;
    const target = nodes.find(node => node.id === edge.target);
    return target?.type === `remote-${edge.sourceHandle}Node` ||
      target?.type === "remote-comfyuiNode" && target.data.comfyuiMediaResult?.kind === edge.sourceHandle;
  });
}

async function publishMediaOutputs(media, options) {
  const { canvas, canvasId, files, source, promptId, getNodes, getEdges, uploadFile, download,
    prepareResultNode, isCurrent, signal = new AbortController().signal, onProgress } = options;
  const names = { image: "图片", video: "视频", audio: "音频" };
  const published = [], errors = [], prepared = [];
  const indices = { image: 0, video: 0, audio: 0 };
  function check() {
    signal.throwIfAborted();
    if (!isCurrent() || canvas?.id !== canvasId) throw new Error("原画布或节点已切换，停止导入生成结果");
  }
  async function call(name, args) {
    check();
    const result = await canvas.call({ name, args }, signal);
    check();
    return result;
  }
  if (!canvas?.call || !files || typeof uploadFile !== "function")
    throw new Error("当前画布未提供自动输出或工作区文件接口，请重新打开工作区");
  check();
  const availableTypes = new Set();
  let cursor;
  do {
    const page = await call("getCanvas", { include: ["nodeTypes"], limit: 100, ...(cursor ? { cursor } : {}) });
    for (const type of page.availableNodeTypes || []) availableTypes.add(type.type);
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (page.hasMore && !cursor) throw new Error("画布节点类型列表不完整，请稍后重试");
  } while (cursor);
  function record(value) {
    const previous = Array.isArray(source.data.mediaResultNodes) ? source.data.mediaResultNodes : [];
    source.data.mediaResultNodes = previous.filter(item => item.nodeId !== value.nodeId).concat(value);
  }
  function inputPort(node, kind) {
    return node?.data?.handles?.find(port => port.type === "target" &&
      (Array.isArray(port.dataType) ? port.dataType.includes(kind.toUpperCase()) : port.dataType === kind.toUpperCase()));
  }
  async function prepareTarget(target, kind, index) {
    if (target.type === "remote-comfyuiNode" || !inputPort(target, kind)) {
      if (!prepareResultNode) throw new Error("当前插件未提供媒体结果节点，请更新插件");
      await prepareResultNode(target, kind, index);
      check();
    }
  }
  async function connectTarget(target, kind) {
    const liveTarget = getNodes().find(node => node.id === target.id);
    const input = inputPort(liveTarget, kind);
    if (!input) throw new Error(`${names[kind]}结果节点没有兼容的接收口，请重新启用插件`);
    await call("connectNodes", { connections: [{ source: source.id, sourceHandle: kind,
      target: target.id, targetHandle: input.id }] });
  }
  if (options.restoreOnly) {
    const records = Array.isArray(source.data.mediaResultNodes) ? [...source.data.mediaResultNodes] : [];
    for (const previous of records.filter(item => !item.archived && item.ready && item.connected === false && ["video", "audio"].includes(item.kind))) {
      check();
      const target = getNodes().find(node => node.id === previous.nodeId);
      if (!target || ![`remote-${previous.kind}Node`, "remote-comfyuiNode"].includes(target.type)) continue;
      try {
        if (!availableTypes.has(`remote-${previous.kind}Node`)) throw new Error(`请先启用 Toonflow 的${names[previous.kind]}节点`);
        if (getEdges().some(edge => edge.target === target.id && edge.source !== source.id))
          throw new Error("结果节点已连接其它来源，保留当前连线");
        await prepareTarget(target, previous.kind, previous.index);
        await connectTarget(target, previous.kind);
        const ready = { ...previous, connected: true };
        record(ready);
        published.push(ready);
      } catch (error) {
        check();
        errors.push(`${names[previous.kind]}：${error.message || String(error)}`);
      }
    }
    return { published, errors };
  }
  function position(kind) {
    const anchor = source.computedPosition || source.position || { x: 0, y: 0 };
    const dimensions = source.dimensions || {};
    const width = Number(dimensions.width) || Number.parseFloat(source.style?.width) || 600;
    const x = anchor.x + width + 100 + ["image", "video", "audio"].indexOf(kind) * 420;
    let y = anchor.y;
    const boxes = getNodes().filter(node => node.id !== source.id && node.type !== "canvasGroup").map(node => {
      const point = node.computedPosition || node.position || { x: 0, y: 0 };
      return { ...point, width: Number(node.dimensions?.width) || 360, height: Number(node.dimensions?.height) || 360 };
    }).filter(box => box.x < x + 360 && box.x + box.width > x);
    for (const box of boxes.sort((a, b) => a.y - b.y))
      if (y < box.y + box.height + 40 && y + 360 + 40 > box.y) y = box.y + box.height + 40;
    return { x, y };
  }
  for (const [offset, item] of media.entries()) {
    check();
    const { kind } = item, index = indices[kind]++;
    onProgress?.({ index: offset + 1, total: media.length, kind, filename: item.filename });
    try {
      const nodeType = `remote-${kind}Node`;
      if (!availableTypes.has(nodeType)) throw new Error(`请先启用 Toonflow 的${names[kind]}节点`);
      const records = Array.isArray(source.data.mediaResultNodes) ? source.data.mediaResultNodes : [];
      const previous = records.find(value => !value.archived && value.kind === kind && value.index === index &&
        value.promptId === promptId && value.key === item.key);
      const nodes = getNodes(), edges = getEdges();
      const resultType = "remote-comfyuiNode";
      const candidate = node => (node?.type === nodeType && (inputPort(node, kind) || previous?.nodeId === node.id) ||
          node?.type === resultType && node.data.comfyuiMediaResult?.kind === kind) &&
        !edges.some(edge => edge.target === node.id && edge.source !== source.id);
      let target = nodes.find(node => node.id === previous?.nodeId && candidate(node));
      if (target && previous.path &&
          target.data.outputs?.[kind]?.value?.url === previous.path) {
        prepared.push({ ...previous, mimeType: item.mimeType });
        continue;
      }
      const blob = await download(item, signal);
      check();
      if (!blob?.size || blob.size > 100 * 1024 * 1024)
        throw new Error(`${names[kind]}文件为空或超过基础节点的 100 MB 上限`);
      if (!target) {
        const type = kind === "image" ? nodeType : resultType;
        if (!availableTypes.has(type)) throw new Error("ComfyUI 结果节点尚未加载，请重新启用插件");
        const created = await call("addNode", {
          type, label: `${names[kind]} · ${item.filename}`.slice(0, 200), position: position(kind)
        });
        target = getNodes().find(node => node.id === created.node?.id);
        if (!target) throw new Error("新增媒体节点未就绪");
      }
      const state = { kind, index, nodeId: target.id, promptId, key: item.key, ready: false, connected: false };
      record(state);
      await prepareTarget(target, kind, index);
      const setterName = `node:set${kind[0].toUpperCase()}${kind.slice(1)}`;
      const tools = await call("getNodeTools", { nodeIds: [target.id], names: [setterName], limit: 50 });
      const setter = tools.nodeTools?.find(tool => tool.name === setterName &&
        tool.parameters?.properties?.path && tool.parameters?.properties?.mimeType);
      if (!setter) throw new Error(`${names[kind]}节点未提供媒体设置函数，请更新或重新启用该节点`);
      const file = new File([blob], item.filename, { type: item.mimeType });
      const path = await uploadFile(files, target.id, file);
      check();
      record({ ...state, path, mimeType: item.mimeType });
      await call("nodeTools", { nodeId: target.id, name: setter.name, args: { path, mimeType: item.mimeType } });
      prepared.push({ ...state, path, mimeType: item.mimeType });
    } catch (error) {
      check();
      errors.push(`${item.filename}：${error.message || String(error)}`);
    }
  }
  if (!prepared.length) return { published, errors };
  check();
  const currentIds = new Set(prepared.map(item => item.nodeId));
  const previousEdges = mediaResultEdges(source, getNodes(), getEdges()).filter(edge => !currentIds.has(edge.target));
  // Save new files first, then detach old receivers before exposing any new source value.
  for (let offset = 0; offset < previousEdges.length; offset += 64) {
    const edgeIds = previousEdges.slice(offset, offset + 64).map(edge => edge.id);
    await call("deleteEdges", { edgeIds });
    if (getEdges().some(edge => edgeIds.includes(edge.id)))
      throw new Error("旧结果连线未断开，已保留旧内容；请检查画布连接状态");
  }
  const currentRecords = Array.isArray(source.data.mediaResultNodes) ? source.data.mediaResultNodes : [];
  source.data.mediaResultNodes = currentRecords.map(item => item.promptId !== promptId && !item.archived
    ? { ...item, archived: true, connected: false } : item);
  options.onReady?.();
  check();
  for (const item of prepared) {
    try {
      const target = getNodes().find(node => node.id === item.nodeId);
      if (!target) throw new Error("新增媒体节点已移除");
      if (!getEdges().some(edge => edge.source === source.id && edge.sourceHandle === item.kind && edge.target === item.nodeId))
        await connectTarget(target, item.kind);
      const ready = { ...item, ready: true, connected: true };
      record(ready);
      published.push(ready);
    } catch (error) {
      check();
      errors.push(`${names[item.kind]}：${error.message || String(error)}`);
    }
  }
  return { published, errors };
}

  const Core = createWorkflowCore();
  // This installation replaced the workflow's old cinema LoRA with its installed V1.
  const modelFileReplacements = { lora_name: {
    "H3\\Minimax H3真实电影质感V0.1（解决张量报错）.safetensors": "Minimax H3\\Minimax H3真实电影质感V1.safetensors",
    "H3\\Minimax H3真实电影质感V0.1（解决张量报错） .safetensors": "Minimax H3\\Minimax H3真实电影质感V1.safetensors"
  } };

  function unwrap(value) {
    if (typeof Vue?.unref === "function") return Vue.unref(value);
    return value && typeof value === "object" && "value" in value ? value.value : value;
  }

  function parseWorkflow(value) {
    return Core.parseWorkflow(value);
  }

  function outputEntries(item) {
    const entries = [];
    for (const [nodeId, node] of Object.entries(item?.outputs || {})) {
      for (const type of ["images", "videos", "audio", "gifs", "files"]) {
        for (const file of node?.[type] || []) entries.push({ nodeId, kind: type, ...file });
      }
    }
    return entries;
  }

  async function fetchJson(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}: ${Core.formatNodeErrors(body?.node_errors) || body?.error?.message || body?.message || body?.raw || text}`);
        error.httpStatus = response.status;
        throw error;
      }
      return body;
    } finally { clearTimeout(timer); }
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function replacePlaceholders(value, replacements) {
    if (typeof value === "string") return value.replace(/\{\{input:(image|video|audio|text|json)\}\}/g, (match, key) => replacements[key] ?? match);
    if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, replacements));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, replacements)]));
    return value;
  }
  const WORKFLOW_STORE_KEY = "toonflow.comfyui.workflows.v1";
  const workflowStoreListeners = new Set();
  function readWorkflowStore() {
    try {
      const raw = globalThis.localStorage?.getItem(WORKFLOW_STORE_KEY);
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(item => item && item.id && item.name && typeof item.workflowText === "string") : [];
    } catch { return null; }
  }
  function writeWorkflowStore(items, updatedId, allowCreate = false) {
    const combined = new Map((readWorkflowStore() ?? items).map(item => [item.id, item]));
    const updated = items.find(item => item.id === updatedId);
    // Only explicit add/save actions may create an ID absent from the shared library.
    if (updated && (allowCreate || combined.has(updatedId))) combined.set(updatedId, updated);
    const next = [...combined.values()];
    try {
      globalThis.localStorage?.setItem(WORKFLOW_STORE_KEY, JSON.stringify(next));
    } catch { /* storage may be unavailable */ }
    return next;
  }

  const declaredHandles = [
      { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "AUDIO", "STRING"], label: "图片、音频、视频、提示词输入" },
      { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
      { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
      { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
      { id: "data", type: "source", dataType: "STRING", label: "结果信息" }
  ];
  return defineComponent({
    name: "ComfyuiWorkflowNode",
    workflowCore: Core,
    inheritAttrs: false,
    handles: declaredHandles,
    setup(props) {
      const hostNode = typeof useNode === "function" ? useNode() : {};
      const hostFlow = typeof useVueFlow === "function" ? useVueFlow() : {};
      const workspaceFilesProvider = typeof Vue.inject === "function" ? Vue.inject("workspaceFiles", undefined) : undefined;
      const canvasProvider = typeof Vue.inject === "function" ? Vue.inject("canvas", undefined) : undefined;
      let data = {};
      const resolveHost = () => unwrap(hostNode) || {};
      const resolveNodeId = () => {
        const host = resolveHost();
        const propNode = unwrap(props?.node);
        return unwrap(host?.id) || propNode?.id || unwrap(propNode?.id);
      };
      const resolveHostNode = () => {
        const host = resolveHost();
        const propNode = unwrap(props?.node);
        const nodeId = resolveNodeId();
        const found = nodeId && typeof hostFlow?.findNode === "function"
          ? unwrap(hostFlow.findNode(nodeId))
          : undefined;
        return found || unwrap(host?.node) || propNode;
      };
      data = unwrap(resolveHostNode()?.data) || unwrap(props?.data) || {};
      const isMediaResult = () => ["video", "audio"].includes(data.comfyuiMediaResult?.kind);
      if (isMediaResult()) return () => h(mediaResultNode);
      const normalDisplayStyle = ref(null);
      const managementDisplayWidth = "min(1400px, calc(100vw - 48px))";
      const persistedNormalStyleKey = "comfyuiNormalDisplayStyle";
      const withoutHeight = value => {
        const { height, ...rest } = value || {};
        return rest;
      };
      const readNodeStyle = node => {
        const styleSource = node?.style;
        return typeof styleSource === "function" ? styleSource(node) : styleSource;
      };
      function recoverPersistedNormalStyle() {
        const node = resolveHostNode();
        const style = readNodeStyle(node);
        if (!node || !style || style.width !== managementDisplayWidth) return;
        const saved = node.data?.[persistedNormalStyleKey];
        const restore = saved && typeof saved === "object" ? withoutHeight(saved) : withoutHeight(style);
        if (!saved) delete restore.width;
        node.style = { ...restore };
        if (node.data && typeof node.data === "object") delete node.data[persistedNormalStyleKey];
      }
      recoverPersistedNormalStyle();
      function setManagementDisplay(open) {
        const node = resolveHostNode();
        if (!node) return;
        const current = readNodeStyle(node);
        if (open) {
          normalDisplayStyle.value = withoutHeight(current);
          if (node.data && typeof node.data === "object")
            node.data[persistedNormalStyleKey] = { ...normalDisplayStyle.value };
          node.style = { ...normalDisplayStyle.value, width: managementDisplayWidth };
        } else {
          const restore = normalDisplayStyle.value || node.data?.[persistedNormalStyleKey];
          if (restore) node.style = { ...restore };
          if (node.data && typeof node.data === "object") delete node.data[persistedNormalStyleKey];
          normalDisplayStyle.value = null;
        }
      }
      watchEffect(() => {
        if (isMediaResult()) return;
        const node = resolveHostNode();
        const styleSource = node?.style;
        const style = readNodeStyle(node);
        if (!style || !Object.hasOwn(style, "height")) return;
        // A saved manual height makes the scaffold scroll its body; workflow controls need natural height.
        node.style = typeof styleSource === "function"
          ? current => withoutHeight(styleSource(current)) : withoutHeight(style);
      });
      if (typeof data.label === "string" && /^ComfyUI\s*工作流$/i.test(data.label.trim()))
        data.label = "ComfyUI 本地工作流";
      if (!data.outputs || typeof data.outputs !== "object") data.outputs = {};
      const baseUrl = ref(data.baseUrl || "http://127.0.0.1:8188");
      const workflowText = ref(typeof data.workflowText === "string" ? data.workflowText : '{\n  "3": {\n    "class_type": "KSampler",\n    "inputs": {}\n  }\n}');
      const status = ref("就绪");
      const promptId = ref("");
      const running = ref(false);
      const outputNotice = ref("");
      const publishingResults = ref(false);
      let outputTransferController;
      const runProgress = ref({ stage: "", percent: 0, detail: "" });
      let progressSocket;
      const closeProgressSocket = () => {
        const socket = progressSocket;
        progressSocket = undefined;
        socket?.close();
      };
      const error = ref("");
      const fileInput = ref();
      const canvasInputs = computed(() => {
        const nodes = unwrap(hostFlow.getNodes) || [...(unwrap(hostFlow.nodeLookup)?.values?.() || [])];
        const edges = unwrap(hostFlow.getEdges) || [];
        return Core.collectCanvas(nodes, edges, resolveNodeId());
      });
      const management = ref(false);
      const workflowName = ref(typeof data.workflowName === "string" ? data.workflowName : "新工作流");
      const workflows = ref(readWorkflowStore() ?? (Array.isArray(data.workflows) ? data.workflows : []));
      const selectedWorkflow = ref(data.selectedWorkflow || "");
      const parameterDefs = ref(clone(Array.isArray(data.parameterDefs) ? data.parameterDefs : []));
      const advancedEditorOpen = ref(false);
      const parameterDefinitionsOpen = ref(true);
      const bindingDefinitionsOpen = ref(true);
      const definitionGroupModes = ref(new Map());
      const preparedParameters = computed(() => {
        try { return Core.prepareParameters(parseWorkflow(workflowText.value), parameterDefs.value); }
        catch { return parameterDefs.value; }
      });
      const managedParameters = computed(() => Core.sortParameters(preparedParameters.value)
        .filter(item => item.tier !== "advanced" || advancedEditorOpen.value));
      const advancedParameterCount = computed(() => preparedParameters.value.filter(item => item.tier === "advanced").length);
      const visibleParameters = computed(() => preparedParameters.value.filter(item => item.visible !== false));
      const groupedVisibleParameters = computed(() => {
        const groups = new Map();
        visibleParameters.value.forEach((item, index) => {
          const key = item.groupKey || `other:${item.nodeId}`;
          const group = groups.get(key) || { key, label: item.groupLabel, category: item.category ?? 5,
            order: item.groupOrder ?? 0, index, items: [] };
          group.items.push({ item, index });
          groups.set(key, group);
        });
        return [...groups.values()].sort((a, b) => a.category - b.category ||
          a.order - b.order || a.index - b.index);
      });
      const parameterValues = ref(clone(data.parameterValues && typeof data.parameterValues === "object" ? data.parameterValues : {}));
      const canvasBindings = ref(clone(Array.isArray(data.canvasBindings) ? data.canvasBindings : []));
      const detectionNotes = ref([]);
      const workflowOutputs = ref(clone(Array.isArray(data.workflowOutputs) ? data.workflowOutputs : []));
      const outputDefinitions = computed(() => {
        try {
          const w = parseWorkflow(workflowText.value);
          const found = new Map(Core.detectOutputs(w).map(item => [`${item.nodeId}:${item.kind}`, item]));
          for (const item of workflowOutputs.value) if (w[item.nodeId]?.class_type === item.classType)
            found.set(`${item.nodeId}:${item.kind}`, item);
          return [...found.values()];
        } catch { return []; }
      });
      const ignoredParameters = ref(data.ignoredParameters || []);
      const ignoredBindings = ref(data.ignoredBindings || []);
      const referenceMode = ref(data.referenceMode || "mentioned");
      const detecting = ref(false);
      const libraryConfirmation = ref(null);
      const confirmationElement = ref();
      let editorEpoch = 0;
      let infoCache = {}, infoUrl = "";
      let runEpoch = 0;
      const parameterEditorOpen = ref(false);
      const composerOpen = ref(data.composerOpen === true);
      const nodePrompt = ref(typeof data.nodePrompt === "string" ? data.nodePrompt : "");
      const promptSource = ref(data.promptSource === "canvas" ||
        (data.promptSource !== "local" && !nodePrompt.value.trim()) ? "canvas" : "local");
      const promptSyncError = ref("");
      const previewUrls = ref({});
      const mentionQuery = ref(null);
      const mentionIndex = ref(0);
      const mentionItems = computed(() => {
        const query = (mentionQuery.value || "").toLowerCase();
        return canvasInputs.value.gallery.filter(r => `${r.alias} ${r.label}`.toLowerCase().includes(query));
      });
      const previewLeases = new Map();
      let editorElement, savedRange, mentionRange, composing = false, disposed = false;
      function persistPrompt() {
        data.nodePrompt = nodePrompt.value;
        data.promptSource = promptSource.value;
        data.composerOpen = composerOpen.value;
      }
      function toggleComposer() {
        composerOpen.value = !composerOpen.value;
        mentionQuery.value = null;
        persistPrompt();
        nextTick?.(() => hostFlow?.updateNodeInternals?.([resolveNodeId()]));
      }
      function safeMediaUrl(url) { return /^(?:https?:|data:(?:image|audio|video)\/|blob:)/i.test(url || "") ? url : ""; }
      function updatePreviews() {
        const gallery = composerOpen.value ? canvasInputs.value.gallery.filter(r => r.kind !== "audio") : [];
        const active = new Set(gallery.map(r => r.key));
        for (const [key, entry] of previewLeases) if (!active.has(key)) {
          entry.cancelled = true;
          entry.lease?.release?.();
          previewLeases.delete(key);
          const next = { ...previewUrls.value }; delete next[key]; previewUrls.value = next;
        }
        for (const r of gallery) {
          if (previewLeases.has(r.key)) continue;
          const entry = { cancelled: false, lease: undefined };
          previewLeases.set(r.key, entry);
          const direct = safeMediaUrl(r.url);
          if (direct) { previewUrls.value = { ...previewUrls.value, [r.key]: direct }; continue; }
          if (/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(r.url)) continue;
          const files = typeof workspaceFilesProvider === "function" ? workspaceFilesProvider() : undefined;
          if (typeof files?.acquireUrl !== "function") continue;
          Promise.resolve().then(async () => {
            const lease = await files.acquireUrl(r.url, r.mimeType);
            entry.lease = lease;
            if (entry.cancelled || disposed) { lease?.release?.(); return; }
            const url = safeMediaUrl(await lease.url);
            if (url && !entry.cancelled && !disposed) previewUrls.value = { ...previewUrls.value, [r.key]: url };
          }).catch(() => { /* A failed thumbnail must not prevent generation. */ });
        }
      }
      if (typeof watchEffect === "function") watchEffect(updatePreviews);
      if (typeof Vue.onUnmounted === "function") Vue.onUnmounted(() => {
        ++runEpoch;
        outputTransferController?.abort();
        closeProgressSocket();
        disposed = true;
        for (const entry of previewLeases.values()) { entry.cancelled = true; entry.lease?.release?.(); }
        previewLeases.clear();
      });
      async function prepareResultNode(node, kind, index) {
        node.data.comfyuiMediaResult = { kind, index, sourceId: resolveNodeId() };
        if (node.type !== "remote-comfyuiNode") {
          hostFlow.updateNode(node.id, { type: "remote-comfyuiNode" });
        }
        await nextTick();
        await nextTick();
      }
      Vue.onMounted?.(async () => {
        if (!data.mediaResultNodes?.some(item => !item.archived && item.ready && item.connected === false && ["video", "audio"].includes(item.kind))) return;
        const source = resolveHostNode(), epoch = runEpoch;
        try {
          const canvas = canvasProvider?.(), files = workspaceFilesProvider?.();
          const restored = await publishMediaOutputs([], {
            canvas, canvasId: canvas?.id, files, source, uploadFile: uploadNodeFile, restoreOnly: true,
            getNodes: () => unwrap(hostFlow.getNodes) || [], getEdges: () => unwrap(hostFlow.getEdges) || [],
            prepareResultNode, isCurrent: () => !disposed && runEpoch === epoch && resolveHostNode() === source
          });
          if (disposed || runEpoch !== epoch) return;
          if (restored.errors.length) error.value = `历史结果连接未完成：${restored.errors.join("；")}`;
          else if (restored.published.length) status.value = `已连接 ${restored.published.length} 个历史结果节点`;
        } catch (cause) {
          if (!disposed && runEpoch === epoch) error.value = `历史结果连接未完成：${cause.message}`;
        }
      });
      function serializePrompt(root) {
        let value = "";
        for (const child of root?.childNodes || []) {
          if (child.nodeType === 3) value += child.textContent.replace(/\u00a0/g, " ");
          else if (child.dataset?.refkey) value += Core.referenceToken(child.dataset.refkey);
          else if (child.nodeName === "BR") value += "\n";
          else {
            const block = /^(DIV|P)$/.test(child.nodeName);
            if (block && value && !value.endsWith("\n")) value += "\n";
            value += serializePrompt(child);
          }
        }
        return value;
      }
      function refreshChip(chip) {
        const r = canvasInputs.value.gallery.find(item => item.key === chip.dataset.refkey);
        chip.className = `comfyui-prompt-chip${r ? "" : " is-disconnected"}`;
        chip.title = r ? `${r.alias} · ${r.label}` : "参考素材已断开或已更换";
        chip.replaceChildren();
        if (r?.kind === "image" && previewUrls.value[r.key]) {
          const img = chip.ownerDocument.createElement("img");
          img.src = previewUrls.value[r.key]; img.alt = ""; img.draggable = false;
          chip.append(img);
        }
        const label = chip.ownerDocument.createElement("span");
        label.textContent = r?.alias || "已断开引用";
        chip.append(label);
      }
      function promptFragment(text) {
        const doc = editorElement.ownerDocument, fragment = doc.createDocumentFragment();
        for (const part of Core.promptSegments(text)) {
          if (part.key) {
            const chip = doc.createElement("span");
            chip.contentEditable = "false"; chip.dataset.refkey = part.key;
            refreshChip(chip); fragment.append(chip);
          } else part.text.split("\n").forEach((line, i) => {
            if (i) fragment.append(doc.createElement("br"));
            fragment.append(doc.createTextNode(line));
          });
        }
        return fragment;
      }
      function syncEditor() {
        if (!editorElement || composing) return;
        if (serializePrompt(editorElement) !== nodePrompt.value) editorElement.replaceChildren(promptFragment(nodePrompt.value));
        else editorElement.querySelectorAll("[data-refkey]").forEach(refreshChip);
        editorElement.dataset.empty = nodePrompt.value ? "false" : "true";
      }
      const setEditorElement = element => {
        if (element === editorElement) return;
        editorElement = element; savedRange = undefined;
        if (element) syncEditor();
      };
      if (typeof watchEffect === "function") watchEffect(() => {
        nodePrompt.value; canvasInputs.value.gallery; previewUrls.value;
        nextTick?.(syncEditor);
      });
      function rememberCaret() {
        const selection = editorElement?.ownerDocument.getSelection();
        if (selection?.rangeCount && editorElement.contains(selection.anchorNode) && editorElement.contains(selection.focusNode)) {
          savedRange = selection.getRangeAt(0).cloneRange();
          return savedRange;
        }
      }
      function updateMention() {
        if (composing) return;
        const range = rememberCaret();
        mentionRange = undefined; mentionQuery.value = null;
        if (!range || !range.collapsed || range.startContainer.nodeType !== 3) return;
        const before = range.startContainer.textContent.slice(0, range.startOffset);
        const match = before.match(/@([^@\s{}]*)$/);
        if (!match) return;
        mentionRange = range.cloneRange();
        mentionRange.setStart(range.startContainer, range.startOffset - match[0].length);
        mentionQuery.value = match[1]; mentionIndex.value = 0;
      }
      function onPromptInput() {
        if (composing) return;
        nodePrompt.value = serializePrompt(editorElement);
        promptSource.value = "local";
        promptSyncError.value = "";
        persistPrompt();
        if (editorElement) editorElement.dataset.empty = nodePrompt.value ? "false" : "true";
        updateMention();
      }
      function insertPrompt(text, range = savedRange) {
        if (!editorElement || running.value) return;
        const doc = editorElement.ownerDocument;
        if (!range || !editorElement.contains(range.startContainer) || !editorElement.contains(range.endContainer)) {
          range = doc.createRange(); range.selectNodeContents(editorElement); range.collapse(false);
        }
        range.deleteContents();
        const fragment = promptFragment(text), last = fragment.lastChild;
        range.insertNode(fragment);
        if (last) { range.setStartAfter(last); range.collapse(true); }
        const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        editorElement.focus(); savedRange = range.cloneRange();
        onPromptInput(); mentionQuery.value = null; mentionRange = undefined;
      }
      function insertReference(r) {
        insertPrompt(Core.referenceToken(r.key) + " ", mentionRange || savedRange);
      }
      function onPromptKeydown(event) {
        event.stopPropagation();
        if (composing || event.isComposing || mentionQuery.value === null) return;
        const items = mentionItems.value;
        if (event.key === "Escape") { event.preventDefault(); mentionQuery.value = null; mentionRange = undefined; }
        else if (items.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          mentionIndex.value = (mentionIndex.value + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          nextTick?.(() => editorElement?.parentElement.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
        } else if (items.length && event.key === "Enter") {
          event.preventDefault(); insertReference(items[mentionIndex.value]);
        }
      }
      function onPromptPaste(event) {
        event.preventDefault(); event.stopPropagation();
        rememberCaret();
        insertPrompt(event.clipboardData?.getData("application/x-toonflow-prompt") || event.clipboardData?.getData("text/plain") || "");
      }
      function onPromptCopy(event) {
        const range = rememberCaret();
        if (!range || range.collapsed) return;
        event.preventDefault();
        const text = serializePrompt(range.cloneContents());
        event.clipboardData?.setData("application/x-toonflow-prompt", text);
        event.clipboardData?.setData("text/plain", Core.promptSegments(text).map(part => part.text ??
          `@${canvasInputs.value.gallery.find(r => r.key === part.key)?.alias || "已断开引用"}`).join(""));
        if (event.type === "cut" && !running.value) { range.deleteContents(); onPromptInput(); }
      }
      function useCanvasPrompt() {
        promptSource.value = "canvas";
        syncCanvasPrompt();
      }
      function syncCanvasPrompt() {
        if (promptSource.value !== "canvas" || running.value || composing) return;
        try {
          const canvas = canvasInputs.value;
          nodePrompt.value = canvas.texts.length ? Core.canvasPrompt(canvas) : "";
          if (promptSyncError.value && error.value === promptSyncError.value) {
            error.value = "";
            status.value = "就绪";
          }
          promptSyncError.value = "";
          persistPrompt();
          nextTick?.(syncEditor);
        } catch (e) {
          promptSyncError.value = `文字节点提示词载入失败：${e.message}`;
        }
      }
      if (typeof watchEffect === "function") watchEffect(syncCanvasPrompt);
      const parameterIssues = computed(() => {
        let workflow;
        try { workflow = parseWorkflow(workflowText.value); } catch { return new Map(); }
        return new Map(parameterDefs.value.flatMap(item => {
          try {
            const value = Core.readInput(workflow, item.nodeId, item.path);
            if (Core.isLink(value, workflow)) throw new Error("参数指向连线，请改为上游常量字段");
            return [];
          } catch (e) { return [[item.key, e.message]]; }
        }));
      });

      const normalizedUrl = computed(() => {
        const url = baseUrl.value.trim() || "http://127.0.0.1:8188";
        return (/^https?:\/\//i.test(url) ? url : `http://${url}`).replace(/\/+$/, "");
      });
      function persistNodeData() {
        data.baseUrl = baseUrl.value;
        data.workflowText = workflowText.value;
        data.workflowName = workflowName.value;
        data.workflows = workflows.value;
        data.selectedWorkflow = selectedWorkflow.value;
        data.parameterDefs = parameterDefs.value;
        data.parameterValues = parameterValues.value;
        data.canvasBindings = canvasBindings.value;
        data.workflowOutputs = workflowOutputs.value;
        data.ignoredParameters = ignoredParameters.value;
        data.ignoredBindings = ignoredBindings.value;
        data.referenceMode = referenceMode.value;
      }
      function resetWorkflowEditor() {
        ++editorEpoch;
        selectedWorkflow.value = "";
        workflowName.value = "";
        workflowText.value = "";
        parameterDefs.value = [];
        parameterValues.value = {};
        canvasBindings.value = [];
        detectionNotes.value = [];
        workflowOutputs.value = [];
        advancedEditorOpen.value = false;
        parameterDefinitionsOpen.value = true;
        bindingDefinitionsOpen.value = true;
        definitionGroupModes.value = new Map();
        ignoredParameters.value = [];
        ignoredBindings.value = [];
        referenceMode.value = "mentioned";
        infoCache = {}; infoUrl = "";
        error.value = "";
      }
      function refreshWorkflowLibrary() {
        const stored = readWorkflowStore();
        if (stored === null) return true;
        workflows.value = stored;
        const removed = selectedWorkflow.value && !stored.some(item => item.id === selectedWorkflow.value);
        if (removed) {
          resetWorkflowEditor();
          libraryConfirmation.value = null;
          status.value = "工作流已删除";
        }
        persistNodeData();
        return !removed;
      }
      workflowStoreListeners.add(refreshWorkflowLibrary);
      const onWorkflowStorage = event => {
        if (event.key === WORKFLOW_STORE_KEY) refreshWorkflowLibrary();
      };
      globalThis.addEventListener?.("storage", onWorkflowStorage);
      if (typeof Vue.onUnmounted === "function") Vue.onUnmounted(() => {
        workflowStoreListeners.delete(refreshWorkflowLibrary);
        globalThis.removeEventListener?.("storage", onWorkflowStorage);
      });
      refreshWorkflowLibrary();
      function persist(allowCreate = false) {
        if (!allowCreate && !refreshWorkflowLibrary()) return;
        if (selectedWorkflow.value) {
          workflows.value = workflows.value.map(item => item.id === selectedWorkflow.value
            ? {
                ...item,
                name: workflowName.value,
                baseUrl: baseUrl.value,
                workflowText: workflowText.value,
                parameterDefs: clone(parameterDefs.value),
                parameterValues: clone(parameterValues.value),
                canvasBindings: clone(canvasBindings.value),
                workflowOutputs: clone(workflowOutputs.value),
                ignoredParameters: [...ignoredParameters.value],
                ignoredBindings: [...ignoredBindings.value],
                referenceMode: referenceMode.value
              }
            : item);
        }
        workflows.value = writeWorkflowStore(workflows.value, selectedWorkflow.value, allowCreate);
        persistNodeData();
      }
      function selectWorkflow(item, allowCreate = false) {
        const stored = readWorkflowStore();
        const latest = stored?.find(entry => entry.id === item.id);
        if (stored !== null && !latest && !allowCreate) { refreshWorkflowLibrary(); return; }
        item = latest || item;
        workflows.value = stored ?? workflows.value;
        if (!workflows.value.some(entry => entry.id === item.id)) workflows.value = [...workflows.value, item];
        ++editorEpoch;
        selectedWorkflow.value = item.id;
        workflowName.value = item.name;
        baseUrl.value = item.baseUrl || baseUrl.value;
        workflowText.value = item.workflowText;
        parameterDefs.value = clone(Array.isArray(item.parameterDefs) ? item.parameterDefs : []);
        parameterValues.value = clone(item.parameterValues && typeof item.parameterValues === "object" ? item.parameterValues : {});
        canvasBindings.value = clone(item.canvasBindings || []);
        detectionNotes.value = [];
        workflowOutputs.value = clone(item.workflowOutputs || []);
        advancedEditorOpen.value = false;
        parameterDefinitionsOpen.value = true;
        bindingDefinitionsOpen.value = true;
        definitionGroupModes.value = new Map();
        ignoredParameters.value = [...(item.ignoredParameters || [])];
        ignoredBindings.value = [...(item.ignoredBindings || [])];
        referenceMode.value = item.referenceMode || "mentioned";
        persist(allowCreate);
      }
      function addWorkflow() {
        if (running.value || detecting.value) return;
        workflows.value = readWorkflowStore() ?? workflows.value;
        resetWorkflowEditor();
        workflowName.value = `新工作流 ${workflows.value.length + 1}`;
        libraryConfirmation.value = null;
        persistNodeData();
      }
      function clearEditableData() {
        if (running.value || detecting.value) return;
        addWorkflow();
        baseUrl.value = "http://127.0.0.1:8188";
        nodePrompt.value = "";
        promptSource.value = "local";
        promptSyncError.value = "";
        savedRange = undefined; mentionRange = undefined; mentionQuery.value = null;
        persistPrompt();
        persistNodeData();
        nextTick?.(syncEditor);
        status.value = "已清空当前编辑内容，新模板尚未保存";
      }
      function saveWorkflow() {
        if (!refreshWorkflowLibrary()) return;
        try { parseWorkflow(workflowText.value); } catch (e) { error.value = e.message; return; }
        const item = { id: selectedWorkflow.value || `workflow-${Date.now()}`, name: workflowName.value.trim() || "未命名工作流", baseUrl: baseUrl.value.trim() || "http://127.0.0.1:8188", workflowText: workflowText.value, parameterDefs: parameterDefs.value, parameterValues: parameterValues.value };
        const index = workflows.value.findIndex(entry => entry.id === item.id);
        workflows.value = index >= 0 ? workflows.value.map((entry, i) => i === index ? item : entry) : [...workflows.value, item];
        selectedWorkflow.value = item.id;
        persist(true); status.value = `已保存：${item.name}`;
      }
      function requestLibraryChange(item) {
        if (!item || running.value || detecting.value) return;
        libraryConfirmation.value = { id: item.id, name: item.name };
        nextTick?.(() => confirmationElement.value?.focus?.());
      }
      function confirmLibraryChange() {
        const action = libraryConfirmation.value;
        if (!action || running.value || detecting.value) return;
        try {
          const stored = readWorkflowStore() ?? workflows.value;
          const next = stored.filter(item => item.id !== action.id);
          if (!globalThis.localStorage?.setItem) throw new Error("工作流存储不可用，未执行删除");
          globalThis.localStorage.setItem(WORKFLOW_STORE_KEY, JSON.stringify(next));
          workflows.value = next;
          if (selectedWorkflow.value === action.id) resetWorkflowEditor();
          persistNodeData();
          libraryConfirmation.value = null;
          for (const refresh of workflowStoreListeners) refresh();
          error.value = "";
          status.value = `已删除：${action.name}`;
        } catch (e) {
          error.value = `删除失败：${e.message}`;
        }
      }
      function addParameter() {
        parameterDefinitionsOpen.value = true;
        let number = 1;
        while (parameterDefs.value.some(item => item.key === `param${number}`)) number++;
        parameterDefs.value = [...parameterDefs.value, {
          key: `param${number}`,
          label: "新参数",
          type: "text",
          nodeId: "",
          path: "",
          defaultValue: "",
          visible: true
        }];
        setDefinitionGroupMode("parameter:custom", "all");
        persist();
      }
      function updateParameter(index, key, value) {
        parameterDefs.value = parameterDefs.value.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item);
        persist();
      }
      function setAllParametersVisible(visible) {
        const keys = new Set(managedParameters.value.map(item => item.key));
        parameterDefs.value = parameterDefs.value.map(item => keys.has(item.key) ? { ...item, visible } : item);
        persist();
      }
      async function loadInfo(workflow, includeLoaders = false, refresh = false) {
        const url = normalizedUrl.value;
        if (infoUrl !== url || refresh) { infoCache = {}; infoUrl = url; }
        const types = [...new Set([...Object.values(workflow).map(n => n.class_type),
          ...(includeLoaders ? ["LoadImage", "LoadAudio", "LoadAudioUI", "LoadVideoUI", "VHS_LoadVideo"] : [])])];
        try { await fetchJson(`${url}/system_stats`, {}, 3500); }
        catch { return { infos: { ...infoCache }, missing: types.filter(type => !infoCache[type]) }; }
        const missing = [];
        // Limit parallel lookups so large workflows do not overwhelm the local server.
        for (let i = 0; i < types.length; i += 6) await Promise.all(types.slice(i, i + 6).map(async type => {
          if (infoCache[type]) return;
          try {
            const result = await fetchJson(`${url}/object_info/${encodeURIComponent(type)}`);
            if (result[type]) infoCache[type] = result[type]; else missing.push(type);
          } catch { missing.push(type); }
        }));
        return { infos: { ...infoCache }, missing };
      }
      async function detectParameters(includeAdvanced = false) {
        if (detecting.value || running.value) return;
        detecting.value = true; error.value = ""; status.value = "检测中...";
        const text = workflowText.value, id = selectedWorkflow.value, url = normalizedUrl.value;
        try {
          const workflow = parseWorkflow(text);
          const { infos, missing } = await loadInfo(workflow, false, true);
          if (text !== workflowText.value || id !== selectedWorkflow.value || url !== normalizedUrl.value) throw new Error("工作流或地址已变化，请重新检测");
          const filled = Core.fillRequiredDefaults(workflow, infos);
          let modelUpdates = [], modelWarning = "";
          try { modelUpdates = Core.resolveModelFiles(workflow, infos, modelFileReplacements); }
          catch (e) { modelWarning = e.message; }
          const found = Core.detect(workflow, infos, { includeAdvanced });
          detectionNotes.value = found.diagnostics || [];
          const before = parameterDefs.value.length;
          parameterDefs.value = Core.mergeDetection(Core.prepareParameters(workflow, parameterDefs.value),
            found.parameters, ignoredParameters.value);
          canvasBindings.value = Core.normalizeH3Bindings(workflow,
            Core.mergeDetection(canvasBindings.value, found.bindings, ignoredBindings.value, Core.bindingId), infos);
          refreshModelChoices(workflow, infos);
          applyModelUpdates(modelUpdates);
          workflowOutputs.value = found.outputs;
          parameterDefinitionsOpen.value = true;
          bindingDefinitionsOpen.value = true;
          if (includeAdvanced) {
            advancedEditorOpen.value = true;
            setDefinitionGroupMode("parameter:advanced", "all");
          }
          if (filled.length || modelUpdates.length) workflowText.value = JSON.stringify(workflow, null, 2);
          persist();
          status.value = `检测完成：新增 ${parameterDefs.value.length - before} 项${includeAdvanced ? "参数" : "主要参数"}，${canvasBindings.value.length} 个输入入口，${found.outputs.length} 个输出节点${filled.length ? `；补全 ${filled.length} 个必填输入` : ""}${modelUpdates.length ? `；修复 ${modelUpdates.length} 个模型文件路径` : ""}${missing.length ? "；部分节点离线，仅按 JSON 检测" : ""}`;
          if (modelWarning) error.value = modelWarning;
        } catch (e) { error.value = e.message; status.value = "检测失败"; }
        finally { detecting.value = false; }
      }
      function updateBinding(index, key, value) {
        canvasBindings.value = canvasBindings.value.map((b, i) => i === index ? { ...b, [key]: value } : b);
        if (key === "kind") setDefinitionGroupMode(`binding:${value}`, "all");
        persist();
      }
      function setAllBindingsEnabled(enabled) {
        canvasBindings.value = canvasBindings.value.map(binding => ({ ...binding, enabled }));
        persist();
      }
      function addBinding() {
        bindingDefinitionsOpen.value = true;
        canvasBindings.value = [...canvasBindings.value, { kind: "text", mode: "file", nodeId: "", path: "", enabled: true }];
        setDefinitionGroupMode("binding:text", "all");
        persist();
      }
      function resetDetection() {
        ignoredParameters.value = []; ignoredBindings.value = [];
        return detectParameters();
      }
      async function uploadReference(r) {
        const controller = new AbortController();
        let timer;
        let blob;
        try {
          const read = async () => {
            if (/^(?:https?:|data:|blob:)/i.test(r.url)) {
              const response = await fetch(r.url, { signal: controller.signal });
              if (!response.ok) throw new Error(`${r.label} 读取失败：${response.status}`);
              return response.blob();
            }
            if (/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(r.url)) throw new Error(`${r.label} 不是可读取的工作区文件或媒体地址`);
            const files = typeof workspaceFilesProvider === "function" ? workspaceFilesProvider() : undefined;
            if (typeof files?.read !== "function") throw new Error("当前画布未提供工作区文件读取能力，请重新打开画布");
            const bytes = await files.read(r.url);
            return new Blob([bytes], { type: r.mimeType || "" });
          };
          blob = await Promise.race([read(), new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error(`${r.label} 读取超时`)); }, 60000);
          })]);
        } finally { clearTimeout(timer); }
        const ext = ({ "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "audio/mpeg": "mp3",
          "audio/flac": "flac", "audio/ogg": "ogg", "audio/wav": "wav", "video/mp4": "mp4", "video/webm": "webm" })[blob.type || r.mimeType] ||
          (r.kind === "image" ? "png" : r.kind === "audio" ? "wav" : "mp4");
        const form = new FormData();
        form.append("image", blob, `toonflow-${r.kind}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        const file = await fetchJson(`${normalizedUrl.value}/upload/image`, { method: "POST", body: form });
        if (!file.name) throw new Error(`${r.label} 上传未返回文件名`);
        return [file.subfolder, file.name].filter(Boolean).join("/");
      }
      function refreshModelChoices(workflow, infos) {
        const detected = new Map(Core.detect(workflow, infos, { includeAdvanced: true }).parameters
          .filter(p => Core.modelField(p.path)).map(p => [`${p.nodeId}:${p.path}`, p]));
        parameterDefs.value = parameterDefs.value.map(p => {
          const latest = detected.get(`${p.nodeId}:${p.path}`);
          return latest?.options ? { ...p, type: "enum", options: latest.options, detectedType: "enum" } : p;
        });
      }
      function applyModelUpdates(updates) {
        parameterDefs.value = parameterDefs.value.map(p => {
          const update = updates.find(item => item.nodeId === p.nodeId && item.path === p.path);
          if (!update) return p;
          if (parameterValues.value[p.key] === update.previous)
            parameterValues.value = { ...parameterValues.value, [p.key]: update.value };
          return p.defaultValue === update.previous ? { ...p, defaultValue: update.value } : p;
        });
      }
      async function connectProgress(url, clientId, epoch, workflow, infos) {
        closeProgressSocket();
        let activePrompt = "";
        const tracker = createExecutionProgress(workflow, infos);
        const early = [];
        function accept(message) {
          if (epoch !== runEpoch || !running.value) return;
          const next = tracker.accept(message, activePrompt);
          if (next) runProgress.value = next;
        }
        const stream = await openExecutionStream({
          url, clientId, bridgeUrl: "http://127.0.0.1:18190",
          request: fetchJson,
          async activateBridge() {
            // Load the embedded node service through Toonflow's tool runtime; no model is run.
            const headers = { "Content-Type": "application/json", "x-toonflow-workspace": "1" };
            const initialized = await fetchJson("/api/singleAgent/create", {
              method: "POST", headers,
              body: JSON.stringify({ tools: [{ node: "comfyuiNode", names: ["comfyuiNodeProgressStatus"] }] })
            }, 10000);
            const sessionId = initialized.data?.sessionId;
            if (!sessionId) throw new Error(initialized.message || "当前 Toonflow 未能加载节点内置进度服务");
            await fetchJson("/api/singleAgent/control", {
              method: "POST", headers, body: JSON.stringify({ sessionId, action: "close" })
            }, 5000);
          },
          onMessage(message) {
            if (!activePrompt) { if (early.length < 200) early.push(message); }
            else accept(message);
          },
          onState(state, reason) {
            if (epoch !== runEpoch || !running.value) return;
            if (state === "disconnected")
              runProgress.value = { ...runProgress.value, stage: "进度连接中断",
                detail: runProgress.value.detail.includes("正在查询任务结果") ? runProgress.value.detail :
                  [runProgress.value.detail, reason ? `实时进度中断：${reason}` : "实时进度连接中断",
                    "正在查询任务结果"].filter(Boolean).join(" · ") };
          }
        });
        if (epoch !== runEpoch || !running.value) { stream.close(); return; }
        progressSocket = stream;
        return {
          get connected() { return stream.connected; },
          bind(id) { activePrompt = id; early.forEach(accept); early.length = 0; }
        };
      }
      async function run() {
        if (running.value) return;
        if (editorElement && !composing && promptSource.value === "local") onPromptInput();
        syncCanvasPrompt();
        const epoch = ++runEpoch;
        let submitting = false;
        closeProgressSocket();
        runProgress.value = { stage: "预检", percent: 0, detail: "检查工作流与模型文件" };
        running.value = true; error.value = ""; outputNotice.value = ""; promptId.value = ""; status.value = "提交中...";
        for (const kind of ["image", "video", "audio", "comfyui", "data"]) delete data.outputs[kind];
        persist();
        const defs = clone(preparedParameters.value), values = clone(parameterValues.value);
        let bindings = clone(canvasBindings.value);
        const workflowSource = workflowText.value, workflowKey = selectedWorkflow.value, bindingSnapshot = JSON.stringify(bindings);
        let persistedSource = workflowSource;
        const prompt = nodePrompt.value;
        const fromCanvas = promptSource.value === "canvas";
        let publication, publicationError;
        try {
          const canvas = typeof canvasProvider === "function" ? canvasProvider() : undefined;
          const files = typeof workspaceFilesProvider === "function" ? workspaceFilesProvider() : undefined;
          publication = { canvas, canvasId: canvas?.id, files, source: resolveHostNode() };
        } catch (e) { publicationError = e.message; }
        try {
          if (fromCanvas && promptSyncError.value) throw new Error(promptSyncError.value);
          let workflow = parseWorkflow(workflowSource);
          const canvas = canvasInputs.value;
          status.value = "工作流预检中...";
          const { infos, missing } = await loadInfo(workflow,
            Boolean(canvas.direct.length || prompt.trim() || Core.isH3ReferenceWorkflow(workflow)), true);
          if (epoch !== runEpoch) return;
          const missingTypes = missing.filter(type => Object.values(workflow).some(n => n.class_type === type));
          if (missingTypes.length) throw new Error(`无法读取本地节点定义，工作流未提交：${missingTypes.join("、")}；请检查 ComfyUI 连接和自定义节点安装`);
          Core.fillRequiredDefaults(workflow, infos);
          if (workflowSource === workflowText.value && workflowKey === selectedWorkflow.value) {
            refreshModelChoices(workflow, infos);
            persist();
          }
          Core.applyParameters(workflow, defs, values, infos);
          const modelUpdates = Core.resolveModelFiles(workflow, infos, modelFileReplacements);
          if (modelUpdates.length && workflowSource === workflowText.value && workflowKey === selectedWorkflow.value &&
              JSON.stringify(parameterValues.value) === JSON.stringify(values)) {
            const savedWorkflow = parseWorkflow(workflowSource);
            for (const update of modelUpdates) Core.writeInput(savedWorkflow, update.nodeId, update.path, update.value);
            workflowText.value = JSON.stringify(savedWorkflow, null, 2);
            persistedSource = workflowText.value;
            applyModelUpdates(modelUpdates);
            persist();
          }
          if (canvas.direct.length || prompt.trim() || Core.isH3ReferenceWorkflow(workflow, infos)) {
            bindings = Core.normalizeH3Bindings(workflow, bindings, infos);
            const selection = Core.selectReferences(canvas, referenceMode.value, fromCanvas ? "" : prompt);
            Core.validateBindings(workflow, bindings, selection);
            // Validate graph rewrites before uploading any files.
            const dryUploads = Object.fromEntries(selection.selected.map(r => [r.key, "toonflow-preflight"]));
            const dryWorkflow = Core.applyCanvas(clone(workflow), bindings, selection, dryUploads, infos);
            Core.fillRequiredDefaults(dryWorkflow, infos);
            Core.validateRequiredInputs(dryWorkflow, infos);
            if (JSON.stringify(bindings) !== bindingSnapshot && persistedSource === workflowText.value &&
                workflowKey === selectedWorkflow.value && JSON.stringify(canvasBindings.value) === bindingSnapshot) {
              canvasBindings.value = clone(bindings);
              persist();
            }
            const uploads = {}, mediaInfo = {};
            for (const r of selection.selected) {
              if (epoch !== runEpoch) return;
              status.value = `上传 ${Core.names[r.kind]} ${r.index}...`;
              runProgress.value = { stage: "上传参考素材", percent: 0, detail: `${Core.names[r.kind]} ${r.index} / ${selection.counts[r.kind]}` };
              uploads[r.key] = await uploadReference(r);
              if (r.kind === "video" && bindings.some(b => b.enabled !== false && b.kind === "video" && b.mode === "director")) {
                status.value = `读取导演台视频信息 ${r.index}...`;
                mediaInfo[r.key] = await fetchJson(`${normalizedUrl.value}/wmr/video_real_info?file=${encodeURIComponent(uploads[r.key])}`);
              }
            }
            workflow = Core.applyCanvas(workflow, bindings, selection, uploads, infos, mediaInfo);
            const replacements = { text: Core.renderPrompt(workflow, selection, infos) };
            for (const r of selection.selected) replacements[r.kind] ??= uploads[r.key];
            workflow = replacePlaceholders(workflow, replacements);
          }
          Core.fillRequiredDefaults(workflow, infos);
          Core.validateRequiredInputs(workflow, infos);
          if (epoch !== runEpoch) return;
          status.value = "提交中...";
          runProgress.value = { stage: "提交任务", percent: 0, detail: "" };
          const clientId = `toonflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const trackPrompt = await connectProgress(normalizedUrl.value, clientId, epoch, workflow, infos);
          if (epoch !== runEpoch) return;
          submitting = true;
          const result = await fetchJson(`${normalizedUrl.value}/prompt`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId })
          });
          submitting = false;
          promptId.value = result.prompt_id || "";
          const validationError = Core.formatNodeErrors(result.node_errors);
          if (validationError) throw new Error(`工作流校验失败${promptId.value ? "（部分分支已入队，勿重复提交）" : ""}：\n${validationError}`);
          if (!promptId.value) throw new Error(result.error?.message || "ComfyUI 未返回 prompt_id");
          runProgress.value = { stage: trackPrompt?.connected ? "等待运行" : "进度连接中断", percent: 0,
            detail: trackPrompt?.connected ? "任务已提交" :
              runProgress.value.detail || "内置实时进度暂不可用，正在查询任务结果" };
          trackPrompt?.bind(promptId.value);
          status.value = `运行中 ${promptId.value}`;
          for (let i = 0; i < 1800 && epoch === runEpoch; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (epoch !== runEpoch) return;
            const history = await fetchJson(`${normalizedUrl.value}/history/${encodeURIComponent(promptId.value)}`);
            if (epoch !== runEpoch) return;
            const item = history[promptId.value];
            if (!item) continue;
            if (["error", "failed"].includes(item.status?.status_str)) throw new Error(item.status.messages?.map(m => JSON.stringify(m)).join("\n") || "工作流执行失败");
            const entries = outputEntries(item);
            const media = describeMediaOutputs(entries, normalizedUrl.value);
            if (media.length && (item.status?.completed || item.status?.status_str === "success")) {
              data.outputs = data.outputs || {};
              const exposeMedia = () => {
                for (const kind of ["image", "video", "audio"]) delete data.outputs[kind];
                for (const entry of media) {
                  const kind = entry.kind;
                  if (!data.outputs[kind]) data.outputs[kind] = { dataType: kind.toUpperCase(),
                    value: { url: entry.url, mimeType: entry.mimeType } };
                }
              };
              const source = resolveHostNode();
              if (!mediaResultEdges(source, unwrap(hostFlow.getNodes) || [], unwrap(hostFlow.getEdges) || []).length)
                exposeMedia();
              data.outputs.comfyui = { dataType: "JSON", value: { promptId: promptId.value, outputs: entries } };
              data.outputs.data = { dataType: "STRING", value: JSON.stringify({ promptId: promptId.value, outputs: entries }) };
              closeProgressSocket();
              runProgress.value = { ...runProgress.value, stage: "生成完成，正在导入结果", percent: 100, detail: "" };
              publishingResults.value = true;
              const transferController = new AbortController();
              outputTransferController = transferController;
              try {
                if (publicationError) throw new Error(publicationError);
                const result = await publishMediaOutputs(media, {
                  ...publication, promptId: promptId.value, uploadFile: uploadNodeFile,
                  signal: transferController.signal,
                  getNodes: () => unwrap(hostFlow.getNodes) || [],
                  getEdges: () => unwrap(hostFlow.getEdges) || [],
                  prepareResultNode,
                  onReady: exposeMedia,
                  isCurrent: () => !disposed && epoch === runEpoch &&
                    resolveHostNode() === publication?.source,
                  onProgress: ({ index, total, kind, filename }) => {
                    runProgress.value = { ...runProgress.value, detail: `保存${Core.names[kind]} ${index}/${total} · ${filename}` };
                  },
                  async download(entry, signal) {
                    const controller = new AbortController();
                    const cancel = () => controller.abort();
                    signal.addEventListener("abort", cancel, { once: true });
                    const timer = setTimeout(cancel, 120000);
                    try {
                      signal.throwIfAborted();
                      const response = await fetch(entry.url, { signal: controller.signal });
                      if (!response.ok) throw new Error(`读取生成文件失败：HTTP ${response.status}`);
                      return await response.blob();
                    } finally {
                      clearTimeout(timer);
                      signal.removeEventListener("abort", cancel);
                    }
                  }
                });
                if (epoch !== runEpoch || disposed) return;
                for (const entry of result.published) if (entry.index === 0)
                  data.outputs[entry.kind] = { dataType: entry.kind.toUpperCase(), value: { url: entry.path, mimeType: entry.mimeType } };
                const results = result.published.map(entry => ({
                  kind: entry.kind, nodeId: entry.nodeId, path: entry.path, connected: entry.connected
                }));
                data.outputs.comfyui.value.resultNodes = results;
                data.outputs.data.value = JSON.stringify({ promptId: promptId.value, outputs: entries, resultNodes: results });
                outputNotice.value = result.errors.length
                  ? `已生成，自动显示成功 ${results.length}/${media.length}：${result.errors.join("；")}`
                  : `已保存到工作区并显示 ${results.length} 个结果节点`;
              } catch (e) {
                if (epoch !== runEpoch || disposed) return;
                outputNotice.value = `已生成，自动显示未完成：${e.message}；结果保留在 ComfyUI 历史中，请勿重复生成`;
              } finally {
                if (outputTransferController === transferController) {
                  publishingResults.value = false;
                  outputTransferController = undefined;
                }
              }
              if (epoch !== runEpoch || disposed) return;
              status.value = "完成";
              runProgress.value = { ...runProgress.value, stage: "完成", percent: 100, detail: outputNotice.value || "输出已就绪" };
              break;
            }
            if (item.status?.completed || item.status?.status_str === "success") {
              throw new Error("任务已结束，但未产生图片、视频或音频输出；请检查工作流的保存/输出节点及 ComfyUI 校验记录。");
            }
          }
          if (status.value.startsWith("运行中")) {
            status.value = "等待超时，请检查 ComfyUI";
            runProgress.value = { ...runProgress.value, stage: "等待超时", detail: "请检查 ComfyUI 队列与任务历史" };
          }
        } catch (e) {
          if (epoch !== runEpoch || disposed) return;
          const message = e instanceof Error ? e.message : String(e);
          const uncertain = submitting && !e.httpStatus;
          error.value = uncertain ? `提交结果未确认，请先检查 ComfyUI 队列或历史，避免重复运行：${message}` : message;
          status.value = uncertain ? "提交未确认" : "失败";
          runProgress.value = { ...runProgress.value, stage: status.value, detail: message };
        }
        finally { if (epoch === runEpoch) { running.value = false; closeProgressSocket(); } }
      }
      async function testConnection() {
        error.value = ""; status.value = "连接测试中...";
        try { await fetchJson(`${normalizedUrl.value}/system_stats`); status.value = "ComfyUI 连接正常"; }
        catch (e) { error.value = e instanceof Error ? e.message : String(e); status.value = "连接失败"; }
      }
      function importWorkflow(event) {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        const epoch = editorEpoch;
        const reader = new FileReader();
        reader.onload = () => {
          if (epoch !== editorEpoch) return;
          try {
            const api = parseWorkflow(String(reader.result || ""));
            workflowText.value = JSON.stringify(api, null, 2); workflowOutputs.value = [];
            persist(); status.value = `已导入 ${file.name}`; error.value = "";
          } catch (e) { error.value = e instanceof Error ? e.message : "JSON 文件解析失败"; status.value = "导入失败"; }
        };
        reader.readAsText(file);
      }
      async function stop() {
        if (!running.value) return;
        if (publishingResults.value) {
          ++runEpoch;
          outputTransferController?.abort();
          outputTransferController = undefined;
          publishingResults.value = false;
          running.value = false;
          status.value = "已停止导入结果";
          runProgress.value = { ...runProgress.value, stage: status.value, detail: "ComfyUI 已生成的结果保留" };
          return;
        }
        // Keep the run locked until the global ComfyUI interrupt request completes.
        try {
          await fetchJson(`${normalizedUrl.value}/interrupt`, { method: "POST" });
          ++runEpoch; status.value = "已请求中断"; running.value = false; closeProgressSocket();
          runProgress.value = { ...runProgress.value, stage: "已请求中断", detail: "等待 ComfyUI 停止当前任务" };
        }
        catch (e) { error.value = `中断未确认：${e.message}`; }
      }

      const field = (label, child) => h("div", { style: { marginBottom: "12px" } }, [h("div", { style: { fontWeight: "600", marginBottom: "6px" } }, label), child]);
      const controlStyle = { width: "100%", minWidth: "0", boxSizing: "border-box", padding: "7px 8px",
        border: "1px solid var(--el-border-color)", borderRadius: "5px", color: "inherit", background: "var(--el-bg-color)", fontSize: "12px" };
      const textInput = (value, onInput, placeholder = "", extra = {}) => h("input", { value: value ?? "", class: "nodrag", placeholder,
        ...extra, style: { ...controlStyle, ...(extra.style || {}) }, onInput });
      const selectInput = (value, entries, onChange, extra = {}) => h("select", { value, class: "nodrag", ...extra, style: controlStyle, onChange },
        entries.map(([v, label]) => h("option", { value: v }, label)));
      const smallButton = (label, onClick, extra = {}) => h(ElementPlus.ElButton, { size: "small", onClick, ...extra }, () => label);
      // Stop canvas gestures without cancelling native scrollbar and form-control behavior.
      const stopCanvasGesture = event => event.stopPropagation();
      const scrollProps = { class: "nodrag nopan nowheel comfyui-scroll", onPointerdown: stopCanvasGesture,
        onMousedown: stopCanvasGesture, onTouchstart: stopCanvasGesture, onWheel: stopCanvasGesture };
      const scrollStyle = { overflow: "auto", scrollbarGutter: "stable", overscrollBehavior: "contain" };
      const libraryConfirmationPanel = () => libraryConfirmation.value ? h(ElementPlus.ElDialog || "div", {
        modelValue: true, title: "删除工作流", appendToBody: true,
        width: "min(420px, calc(100vw - 32px))", closeOnClickModal: false,
        "onUpdate:modelValue": value => { if (!value) libraryConfirmation.value = null; }
      }, { default: () => h("section", {
        ref: confirmationElement, role: "alertdialog", tabindex: -1,
        "aria-label": "删除工作流",
        class: "nodrag nopan", onKeydown: e => {
          if (e.key === "Escape") { e.stopPropagation(); libraryConfirmation.value = null; }
        },
        style: { marginTop: "10px", padding: "12px", border: "1px solid var(--el-color-danger)",
          borderRadius: "5px", background: "var(--el-color-danger-light-9)", overflowWrap: "anywhere" }
      }, [
        h("strong", {}, `删除“${libraryConfirmation.value.name}”？`),
        h("p", { style: { margin: "8px 0", lineHeight: "1.6" } },
          "此工作流将从共享列表中删除，使用它的节点将重置工作流配置。此操作不可撤销。"),
        h("div", { style: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px" } }, [
          smallButton("取消", () => { libraryConfirmation.value = null; }),
          smallButton("确认删除", confirmLibraryChange,
            { type: "danger", disabled: running.value || detecting.value })
        ])
      ]) }) : null;
      function valueControl(item, value, update) {
        if (item.type === "boolean") {
          const checkbox = h("input", { type: "checkbox", class: "nodrag", checked: value === true,
            "aria-label": item.label, onChange: e => update(e.target.checked) });
          return item.booleanLabels ? h("label", { style: { display: "flex", alignItems: "center", gap: "5px", fontSize: "12px" } },
            [checkbox, h("span", {}, item.booleanLabels[String(value === true)] || (value ? "开启" : "关闭"))]) : checkbox;
        }
        if (item.type === "enum" && item.options?.length) return selectInput(value,
          [...(!item.options.includes(value) ? [[value, `${Core.modelField(item.path) ? "未安装" : "无效选项"}：${value}`]] : []),
            ...item.options.map(v => [v, item.optionLabels?.[String(v)] || String(v)])],
          e => update(item.options.find(v => String(v) === e.target.value)), { "aria-label": item.label });
        return textInput(value, e => update(e.target.value), "", { "aria-label": item.label,
          ...(item.type === "number" ? { type: "number", min: item.min, max: item.max, step: item.step || "any", inputMode: "decimal" } : {}) });
      }
      const sectionHeading = (label, controls = []) => h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" } },
        [h("strong", {}, label), h("div", { style: { display: "flex", gap: "6px" } }, controls)]);
      const definitionHeading = (label, count, open, contentId, controls) => h("div", {
        class: "comfyui-definition-heading"
      }, [
        h("button", { type: "button", class: "nodrag nopan comfyui-definition-toggle",
          "aria-label": `${open.value ? "收起" : "展开"}${label}`, "aria-expanded": open.value,
          "aria-controls": contentId,
          onClick: () => {
            open.value = !open.value;
            nextTick?.(() => hostFlow?.updateNodeInternals?.([resolveNodeId()]));
          } }, [
          h(IconChevronRight, { size: 16, "aria-hidden": true,
            style: { flexShrink: "0", transform: open.value ? "rotate(90deg)" : undefined } }),
          h("strong", {}, `${label} · ${count}`)
        ]),
        h("div", { class: "comfyui-definition-actions" }, controls)
      ]);
      function setDefinitionGroupMode(key, mode) {
        definitionGroupModes.value = new Map([...definitionGroupModes.value, [key, mode]]);
      }
      const definitionField = (label, control) => h("div", { class: "comfyui-definition-field" }, [
        h("span", { class: "comfyui-definition-field-label" }, label), control
      ]);
      function definitionGroup(scope, key, label, items, isSelected, renderRow) {
        const stateKey = `${scope}:${key}`, mode = definitionGroupModes.value.get(stateKey) || "selected";
        const selected = items.filter(isSelected).length;
        const shown = mode === "closed" ? [] : mode === "all" ? items : items.filter(isSelected);
        const contentId = `${resolveNodeId()}-${scope}-${encodeURIComponent(key)}`;
        const collapse = mode === "all" || mode === "selected" && selected > 0 && selected === items.length;
        return h("section", { key, class: "comfyui-definition-group",
          [scope === "parameter" ? "data-definition-group" : "data-binding-group"]: key, "data-group-mode": mode }, [
          h("button", { type: "button", class: "nodrag nopan comfyui-definition-toggle",
            "aria-label": `${label}分组`, "aria-expanded": shown.length > 0, "aria-controls": contentId,
            title: collapse ? "收起全部" : "展开全部",
            onClick: () => setDefinitionGroupMode(stateKey, collapse ? "closed" : "all") }, [
            h(IconChevronRight, { size: 16, "aria-hidden": true,
              style: { flexShrink: "0", transform: shown.length ? "rotate(90deg)" : undefined } }),
            h("strong", {}, label),
            h("span", { class: "comfyui-definition-count" }, `${selected} / ${items.length}`)
          ]),
          h("div", { id: contentId }, shown.map(renderRow))
        ]);
      }
      function definitionToolbar(items, isSelected, label, update) {
        const selected = items.filter(isSelected).length;
        return h("div", { class: "comfyui-definition-toolbar" }, [
          h("label", { class: "comfyui-definition-selection" }, [
            h("input", { type: "checkbox", class: "nodrag", "aria-label": label, title: "全选 / 取消全选",
              disabled: !items.length, checked: items.length > 0 && selected === items.length,
              indeterminate: selected > 0 && selected < items.length,
              onChange: e => update(e.target.checked) }),
            h("span", {}, "全选")
          ]),
          h("span", {}, `已选 ${selected} / ${items.length}`)
        ]);
      }
      function parameterDefinitionRows() {
        const groups = new Map();
        for (const item of managedParameters.value) {
          const key = item.tier === "advanced" ? "advanced" :
            item.groupKey?.startsWith("model:") ? "model" : item.groupKey?.startsWith("other:") ? "custom" : item.groupKey || "custom";
          const group = groups.get(key) || { key, label: key === "advanced" ? "高级参数" :
            key === "custom" ? "自定义设置" : item.groupLabel || "其它参数", items: [] };
          group.items.push(item); groups.set(key, group);
        }
        return [...groups.values()].map(group => definitionGroup("parameter", group.key, group.label, group.items,
          item => item.visible !== false, item => {
              const index = parameterDefs.value.findIndex(p => p.key === item.key);
              return h("div", { key: item.key, class: "comfyui-definition-row", "data-definition-key": item.key,
                style: parameterIssues.value.has(item.key) ? { background: "var(--el-color-danger-light-9)" } : undefined,
                title: parameterIssues.value.get(item.key) || item.sourceLabel, "data-invalid": parameterIssues.value.has(item.key) || undefined }, [
                h("label", { class: "comfyui-definition-selection", title: "在主界面显示此参数" }, [
                  h("input", { type: "checkbox", class: "nodrag comfyui-param-visibility", checked: item.visible !== false,
                    "aria-label": `显示参数 ${item.label || item.key}`, onChange: e => updateParameter(index, "visible", e.target.checked) }),
                  h("span", {}, "显示")
                ]),
                definitionField("名称", textInput(item.label, e => updateParameter(index, "label", e.target.value), "名称",
                  { "aria-label": `参数名称 ${item.key}` })),
                definitionField("节点 ID", textInput(item.nodeId, e => updateParameter(index, "nodeId", e.target.value), "ID",
                  { "aria-label": `参数节点 ID ${item.label || item.key}` })),
                definitionField("inputs 字段", textInput(item.path, e => updateParameter(index, "path", e.target.value), "字段",
                  { "aria-label": `参数字段 ${item.label || item.key}` })),
                definitionField("类型", selectInput(item.type || "text", [["text", "文本"], ["number", "数字"], ["boolean", "开关"], ["enum", "选项"]],
                  e => updateParameter(index, "type", e.target.value), { "aria-label": `参数类型 ${item.label || item.key}` })),
                definitionField("默认值", valueControl(item, item.defaultValue, v => updateParameter(index, "defaultValue", v)))
              ]);
          }));
      }
      const parameterDefinitionEditor = () => h("section", { class: "comfyui-definition-layout",
        style: { marginTop: "12px", borderTop: "1px solid var(--el-border-color-lighter)", paddingTop: "12px" } }, [
        definitionHeading("主要参数", preparedParameters.value.length - advancedParameterCount.value, parameterDefinitionsOpen,
          `${resolveNodeId()}-parameter-definitions`, [smallButton("+", addParameter, { title: "添加参数", "aria-label": "添加参数" })]),
        h("div", { id: `${resolveNodeId()}-parameter-definitions`, hidden: !parameterDefinitionsOpen.value }, parameterDefinitionsOpen.value ? [
        h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginBottom: "8px" } }, [
          smallButton("提取高级参数", () => detectParameters(true), { text: true, disabled: detecting.value || running.value }),
          advancedParameterCount.value ? smallButton(advancedEditorOpen.value ? "收起高级参数" : "展开高级参数",
            () => { advancedEditorOpen.value = !advancedEditorOpen.value; }, { text: true, "aria-expanded": advancedEditorOpen.value }) : null,
          advancedParameterCount.value ? h("span", { style: { fontSize: "11px", color: "var(--el-text-color-secondary)" } }, `${advancedParameterCount.value} 项高级参数`) : null
        ]),
        parameterIssues.value.size ? h("div", { role: "alert", style: { color: "var(--el-color-danger)", fontSize: "12px", marginBottom: "6px" } },
          `${parameterIssues.value.size} 项参数绑定无效`) : null,
        h("div", { ...scrollProps, class: `${scrollProps.class} comfyui-parameter-definition-list` }, [
          definitionToolbar(managedParameters.value, item => item.visible !== false, "全选自定义参数", setAllParametersVisible),
          h("div", { class: "comfyui-definition-columns", "aria-hidden": true },
            ["显示", "名称", "节点 ID", "inputs 字段", "类型", "默认值"].map(t => h("span", {}, t))),
          ...parameterDefinitionRows()
        ])
        ] : [])
      ]);
      function bindingRows() {
        return ["text", "image", "audio", "video"].map(kind => {
          const items = canvasBindings.value.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === kind);
          if (!items.length) return null;
          return definitionGroup("binding", kind, `${Core.names[kind]}输入`, items, ({ b }) => b.enabled !== false,
            ({ b, i }) => {
              const name = b.label || `${Core.names[kind]}参考`, identity = `${b.nodeId}.${b.path}`;
              return h("div", { key: i, class: "comfyui-definition-row", "data-binding-index": i, title: b.label }, [
                h("label", { class: "comfyui-definition-selection", title: "启用此输入入口" }, [
                  h("input", { type: "checkbox", class: "nodrag comfyui-binding-enabled", checked: b.enabled !== false,
                    "aria-label": `启用入口 ${name} ${identity}`, onChange: e => updateBinding(i, "enabled", e.target.checked) }),
                  h("span", {}, "启用")
                ]),
                definitionField("名称", textInput(name, e => updateBinding(i, "label", e.target.value), "名称",
                  { "aria-label": `入口名称 ${identity}` })),
                definitionField("节点 ID", textInput(b.nodeId, e => updateBinding(i, "nodeId", e.target.value), "节点 ID",
                  { "aria-label": `入口节点 ID ${name} ${identity}` })),
                definitionField("inputs 字段", textInput(b.path, e => updateBinding(i, "path", e.target.value), "inputs 字段",
                  { "aria-label": `入口字段 ${name} ${identity}` })),
                definitionField("类型", selectInput(b.kind, Object.entries(Core.names), e => updateBinding(i, "kind", e.target.value),
                  { "aria-label": `入口类型 ${name} ${identity}` })),
                definitionField("参考上限", ["slots", "list"].includes(b.mode)
                  ? textInput(b.max, e => updateBinding(i, "max", e.target.value), "上限",
                    { type: "number", min: 0, max: b.capacity, title: `最多 ${b.capacity} 个`,
                      "aria-label": `参考上限 ${name} ${identity}` })
                  : h("span", { class: "comfyui-definition-value" },
                    kind === "text" ? "提示词" : b.mode === "director" ? b.label : "文件入口"))
              ]);
            });
        });
      }
      const bindingEditor = () => h("section", { class: "comfyui-definition-layout",
        style: { margin: "12px 0", paddingTop: "12px", borderTop: "1px solid var(--el-border-color-lighter)" } }, [
        definitionHeading("输入入口", canvasBindings.value.length, bindingDefinitionsOpen, `${resolveNodeId()}-binding-definitions`, [
          selectInput(referenceMode.value, [["mentioned", "文字参考"], ["all", "全部连线"]], e => { referenceMode.value = e.target.value; persist(); }),
          smallButton("+", addBinding,
            { title: "添加画布绑定", "aria-label": "添加画布绑定" })
        ]),
        h("div", { id: `${resolveNodeId()}-binding-definitions`, hidden: !bindingDefinitionsOpen.value }, bindingDefinitionsOpen.value ? [
        h("div", { ...scrollProps, class: `${scrollProps.class} comfyui-binding-definition-list` }, [
          definitionToolbar(canvasBindings.value, binding => binding.enabled !== false, "全选输入入口", setAllBindingsEnabled),
          h("div", { class: "comfyui-definition-columns", "aria-hidden": true },
            ["启用", "名称", "节点 ID", "inputs 字段", "类型", "参考上限"].map(label => h("span", {}, label))),
          ...bindingRows()
        ])
        ] : [])
      ]);
      const outputDefinitionPanel = () => h("section", { style: { margin: "12px 0", paddingTop: "12px", borderTop: "1px solid var(--el-border-color-lighter)" } }, [
        sectionHeading(`输出节点 · ${outputDefinitions.value.length}`),
        outputDefinitions.value.length ? h("div", { ...scrollProps },
          outputDefinitions.value.map(item => h("div", { key: `${item.nodeId}:${item.kind}`, "data-output-node": item.nodeId,
            style: { display: "grid", gridTemplateColumns: "76px 66px minmax(0,1fr)", gap: "8px", padding: "5px 0", fontSize: "12px" } }, [
            h("span", {}, `${Core.names[item.kind]}${item.preview ? "预览" : "输出"}`),
            h("span", {}, `ID ${item.nodeId}`),
            h("span", { style: { overflowWrap: "anywhere" } }, item.label)
          ]))) : h("span", { style: { color: "var(--el-text-color-secondary)", fontSize: "12px" } }, "未识别到媒体输出节点")
      ]);
      const parameterValue = item => h("div", { key: item.key, "data-parameter-key": item.key,
        style: { minWidth: "0" }, title: `${item.sourceLabel || ""} · ${item.nodeId}.${item.path}` }, [
        h("label", { style: { display: "block", marginBottom: "5px", fontSize: "12px", overflowWrap: "anywhere" } }, item.label || item.key),
        valueControl(item, parameterValues.value[item.key] ?? item.defaultValue ?? "", v => {
          parameterValues.value = { ...parameterValues.value, [item.key]: v }; persist();
        })
      ]);
      const parameterEditor = () => !visibleParameters.value.length ? null : h("section", { class: "nodrag nopan comfyui-parameters", onClick: e => e.stopPropagation(),
        style: { marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--el-border-color-light)" } }, [
          sectionHeading(`工作流参数 · ${visibleParameters.value.length}`, [smallButton(parameterEditorOpen.value ? "收起参数" : "展开参数",
            () => { parameterEditorOpen.value = !parameterEditorOpen.value; nextTick?.(() => hostFlow?.updateNodeInternals?.([resolveNodeId()])); },
            { text: true, "aria-expanded": parameterEditorOpen.value })]),
          !parameterEditorOpen.value ? null : h("div", { class: "nodrag nopan comfyui-parameter-values" }, groupedVisibleParameters.value.map(group =>
              h("section", { key: group.key, "data-parameter-group": group.key,
                style: { display: "grid", gridTemplateColumns: group.key.startsWith("model:") ? "minmax(0,1fr)" : "repeat(2,minmax(0,1fr))",
                  gap: "10px", marginBottom: "10px" } }, [
                group.category > 1 && group.label ? h("strong", { style: { gridColumn: "1 / -1", fontSize: "12px" } }, group.label) : null,
                ...group.items.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) ||
                  String(a.item.nodeId).localeCompare(String(b.item.nodeId), undefined, { numeric: true }) || a.index - b.index)
                  .map(({ item }) => parameterValue(item))
              ])))
        ]);
      const referenceCounts = () => {
        const counts = { image: 0, audio: 0, video: 0 };
        canvasInputs.value.gallery.forEach(r => counts[r.kind]++);
        if (!Object.values(counts).some(Boolean)) return null;
        return h("section", { class: "comfyui-reference-counts", style: { marginTop: "12px", display: "flex",
          flexWrap: "wrap", gap: "6px 16px", color: "var(--el-text-color-secondary)", fontSize: "12px" } },
          Object.entries(counts).filter(([, count]) => count).map(([kind, count]) =>
            h("span", {}, `画布参考${Core.names[kind]}${count}`)));
      };
      const mediaThumb = r => {
        const src = previewUrls.value[r.key];
        const fallback = h("span", { class: "comfyui-media-kind" }, Core.names[r.kind]);
        if (r.kind === "image" && src) return [fallback, h("img", { src, alt: r.alias, draggable: false,
          onError: e => { e.target.style.visibility = "hidden"; } })];
        if (r.kind === "video" && src) return [fallback, h("video", { src, muted: true, preload: "metadata", playsinline: true,
          onError: e => { e.target.style.visibility = "hidden"; } })];
        return fallback;
      };
      const composer = () => !composerOpen.value ? null : h("section", {
        class: "nodrag nopan nowheel comfyui-composer", onClick: e => e.stopPropagation(), onKeydown: e => e.stopPropagation()
      }, [
        h("div", { class: "comfyui-composer-top" }, [
          h("strong", {}, "提示词"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, [
            canvasInputs.value.texts.length ? smallButton("载入文字", useCanvasPrompt, { text: true, disabled: running.value,
              title: "将已连接文字节点的提示词载入当前输入框" }) : null,
            smallButton("@", () => {
              editorElement?.focus(); rememberCaret();
              mentionQuery.value = ""; mentionIndex.value = 0; mentionRange = undefined;
            }, { text: true, disabled: running.value, title: "引用连接的图片、音频或视频", "aria-label": "插入参考素材" })
          ])
        ]),
        canvasInputs.value.gallery.length ? h("div", { class: "comfyui-connected-media", "aria-label": "已连接参考素材" },
          canvasInputs.value.gallery.map(r => h("button", { key: r.key, type: "button", class: "comfyui-media-tile",
            "aria-label": `引用${r.alias}`, title: `${r.alias} · ${r.label}`, disabled: running.value,
            onMousedown: e => e.preventDefault(), onClick: () => insertReference(r) }, [
              h("div", { class: "comfyui-media-thumb" }, mediaThumb(r)),
              h("span", { class: "comfyui-media-alias" }, r.alias)
            ]))) : null,
        h("div", { class: "comfyui-prompt-wrap" }, [
          h("div", { key: "prompt-editor", ref: setEditorElement, class: "comfyui-prompt-editor nodrag nopan nowheel",
            contenteditable: running.value ? "false" : "true", role: "textbox", "aria-label": "ComfyUI 提示词",
            "aria-multiline": "true", spellcheck: false,
            "data-placeholder": canvasInputs.value.texts.length ? "沿用已连接文字节点的提示词" : "输入提示词",
            onInput: onPromptInput, onKeydown: onPromptKeydown, onKeyup: event => {
              if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) updateMention();
            }, onClick: updateMention, onMouseup: rememberCaret, onPaste: onPromptPaste, onCopy: onPromptCopy, onCut: onPromptCopy,
            onCompositionstart: () => { composing = true; mentionQuery.value = null; },
            onCompositionend: () => { composing = false; onPromptInput(); },
            onBlur: () => { mentionQuery.value = null; mentionRange = undefined; },
            onDrop: event => event.preventDefault()
          }),
          mentionQuery.value === null ? null : h("div", { class: "comfyui-mention-menu", role: "listbox", "aria-label": "选择参考素材" },
            mentionItems.value.length ? mentionItems.value.map((r, i) => h("button", {
              key: r.key, type: "button", role: "option", "aria-selected": i === mentionIndex.value,
              class: "comfyui-mention-option", title: r.label, onMousedown: e => e.preventDefault(),
              onClick: () => insertReference(r)
            }, [
              h("span", { class: "comfyui-mention-thumb" }, mediaThumb(r)),
              h("span", {}, r.alias), h("span", { class: "comfyui-mention-label" }, r.label)
            ])) : h("span", { class: "comfyui-mention-empty" }, canvasInputs.value.gallery.length ? "没有匹配素材" : "暂无连接素材"))
        ])
      ]);
      function frameStyle() {
        const style = readNodeStyle(resolveHostNode());
        if (style?.width) return undefined;
        return { width: `min(${management.value ? 980 : composerOpen.value || parameterEditorOpen.value ? 600 : 460}px, calc(100vw - 32px))` };
      }
      return () => isMediaResult() ? h(mediaResultNode) : h(nodeSkeleton, {
        label: data.label || "ComfyUI 本地工作流",
        handles: declaredHandles,
        outputs: data.outputs,
        style: frameStyle()
      }, { default: () => h("div", {
        class: "comfyui-node",
        onClick: event => {
          if (management.value) return;
          const target = event.target;
          if (target && typeof target.closest === "function" && target.closest("input,textarea,select,button,[contenteditable],.comfyui-composer,.comfyui-parameters")) return;
          toggleComposer();
        },
        style: { width: "100%", minWidth: "0", color: "var(--el-text-color-primary)", fontSize: "13px", letterSpacing: "0" }
      }, [
        h("style", {}, `
          .comfyui-scroll::-webkit-scrollbar{width:12px;height:12px}
          .comfyui-scroll::-webkit-scrollbar-track{background:var(--el-bg-color)}
          .comfyui-scroll::-webkit-scrollbar-thumb{background:var(--el-border-color);border:2px solid var(--el-bg-color);border-radius:6px;min-height:32px}
          .comfyui-scroll::-webkit-scrollbar-thumb:hover{background:var(--el-text-color-secondary)}
          .comfyui-definition-layout{container-type:inline-size}
          .comfyui-definition-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
          .comfyui-definition-heading>.comfyui-definition-toggle{flex:1;min-width:0;width:auto}
          .comfyui-definition-actions{display:flex;align-items:center;gap:6px}
          .comfyui-definition-toolbar{display:flex;align-items:center;gap:16px;min-height:48px;padding:4px 0;background:var(--el-bg-color);border-bottom:1px solid var(--el-border-color-lighter);font-size:12px;color:var(--el-text-color-secondary)}
          .comfyui-definition-selection{display:flex;align-items:center;justify-content:center;gap:6px;min-width:68px;min-height:44px;padding:0 8px;cursor:pointer;white-space:nowrap;border-radius:4px;font-size:12px;color:var(--el-text-color-primary)}
          .comfyui-definition-selection:hover{background:var(--el-fill-color-light)}
          .comfyui-definition-selection input{width:20px;height:20px;flex:0 0 20px;margin:0;accent-color:var(--el-color-primary);cursor:pointer}
          .comfyui-definition-selection:has(input:disabled){opacity:.5;cursor:default}
          .comfyui-definition-selection:focus-within,.comfyui-definition-toggle:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:-2px}
          .comfyui-definition-row,.comfyui-definition-columns{display:grid;grid-template-columns:68px minmax(100px,1.15fr) 64px minmax(100px,1fr) 76px minmax(120px,1.3fr);gap:10px;align-items:center}
          .comfyui-definition-columns{padding:10px 0 4px;color:var(--el-text-color-secondary);font-size:11px}
          .comfyui-definition-columns>span:first-child{text-align:center}
          .comfyui-definition-group{padding-bottom:6px}
          .comfyui-definition-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:8px 4px;border:0;border-radius:4px;text-align:left;cursor:pointer;color:inherit;background:transparent;font:inherit;font-size:13px}
          .comfyui-definition-toggle:hover{background:var(--el-fill-color-light)}
          .comfyui-definition-count{margin-left:auto;padding-right:8px;color:var(--el-text-color-secondary);font-size:12px;font-variant-numeric:tabular-nums}
          .comfyui-definition-row{padding:6px 0;border-bottom:1px solid var(--el-border-color-lighter)}
          .comfyui-definition-field{min-width:0}
          .comfyui-definition-field-label{display:none}
          .comfyui-definition-value{display:block;font-size:12px;color:var(--el-text-color-secondary);overflow-wrap:anywhere}
          @container(max-width:700px){
            .comfyui-definition-columns{display:none}
            .comfyui-definition-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;padding:12px 0}
            .comfyui-definition-row>.comfyui-definition-selection{align-self:end;justify-self:start}
            .comfyui-definition-field-label{display:block;margin-bottom:5px;font-size:11px;color:var(--el-text-color-secondary)}
          }
          .comfyui-composer{margin-top:12px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color)}
          .comfyui-composer:focus-within{border-color:var(--el-color-primary)}
          .comfyui-composer-top{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px}
          .comfyui-connected-media{display:flex;gap:8px;padding:2px 12px 10px;overflow:auto;max-height:120px}
          .comfyui-media-tile{flex:0 0 64px;width:64px;border:0;padding:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
          .comfyui-media-thumb{position:relative;width:64px;height:54px;border:1px solid var(--el-border-color-lighter);border-radius:5px;overflow:hidden;background:var(--el-fill-color-light);display:flex;align-items:center;justify-content:center}
          .comfyui-media-thumb img,.comfyui-media-thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
          .comfyui-media-tile:hover .comfyui-media-thumb{border-color:var(--el-color-primary)}
          .comfyui-media-kind{font-size:11px;color:var(--el-text-color-secondary)}
          .comfyui-media-alias{display:block;font-size:11px;line-height:20px;white-space:nowrap}
          .comfyui-prompt-wrap{position:relative;min-width:0}
          .comfyui-prompt-editor{min-height:116px;padding:10px 12px 14px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;font-size:13px}
          .comfyui-prompt-editor[data-empty="true"]:before{content:attr(data-placeholder);color:var(--el-text-color-secondary);pointer-events:none}
          .comfyui-prompt-chip{display:inline-flex;vertical-align:middle;align-items:center;gap:4px;max-width:100%;border:1px solid var(--el-border-color-lighter);border-radius:5px;background:var(--el-fill-color-light);padding:0 5px;margin:0 2px;font-size:12px;line-height:26px;white-space:normal}
          .comfyui-prompt-chip img{width:22px;height:22px;object-fit:cover;border-radius:3px}
          .comfyui-prompt-chip.is-disconnected{color:var(--el-color-danger);border-color:var(--el-color-danger)}
          .comfyui-mention-menu{position:absolute;left:8px;right:8px;top:100%;z-index:100;max-height:224px;overflow:auto;background:var(--el-bg-color-overlay);border:1px solid var(--el-border-color);border-radius:6px;padding:4px;box-shadow:0 4px 14px #00000018}
          .comfyui-mention-option{width:100%;display:flex;align-items:center;gap:8px;text-align:left;border:0;border-radius:4px;color:inherit;background:transparent;padding:5px;cursor:pointer;font:inherit}
          .comfyui-mention-option[aria-selected="true"],.comfyui-mention-option:hover{background:var(--el-color-primary-light-9)}
          .comfyui-mention-thumb{position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 30px;width:30px;height:30px;overflow:hidden;border-radius:4px;background:var(--el-fill-color-light)}
          .comfyui-mention-thumb img,.comfyui-mention-thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
          .comfyui-mention-label{flex:1;min-width:0;color:var(--el-text-color-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .comfyui-mention-empty{display:block;padding:8px;color:var(--el-text-color-secondary)}
          @media(max-width:640px){.comfyui-node .comfyui-management{grid-template-columns:minmax(0,1fr)!important}.comfyui-node .comfyui-workflow-list{border-right:0!important;border-bottom:1px solid var(--el-border-color-lighter)}.comfyui-node .comfyui-parameter-values{grid-template-columns:minmax(0,1fr)!important}}
        `),
        h("header", { style: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "10px", alignItems: "center",
          padding: "8px", borderBottom: "1px solid var(--el-border-color-light)", background: "var(--el-bg-color-overlay)" } }, [
          management.value ? h("strong", { style: { fontSize: "16px" } }, "ComfyUI 本地工作流管理") : h("span"),
          management.value ? h("label", { style: { display: "flex", alignItems: "center", gap: "8px", flex: "1 1 260px", maxWidth: "370px", fontSize: "12px" } },
            [h("span", { style: { whiteSpace: "nowrap" } }, "ComfyUI 地址"), textInput(baseUrl.value, e => { baseUrl.value = e.target.value; }, "http://127.0.0.1:8188")]) : null,
          smallButton(management.value ? "返回工作流" : "管理", e => {
            e.stopPropagation();
            const next = !management.value;
            setManagementDisplay(next);
            management.value = next;
            nextTick?.(() => hostFlow?.updateNodeInternals?.([resolveNodeId()]));
          }, { text: true, disabled: running.value || detecting.value })
        ]),
        management.value ? h("div", { class: "comfyui-management", style: { display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", minHeight: "400px", border: "1px solid var(--el-border-color-light)", borderTop: "0", borderRadius: "0 0 8px 8px", overflow: "hidden" } }, [
          h("aside", { class: "comfyui-workflow-list", style: { padding: "14px 10px", borderRight: "1px solid var(--el-border-color-lighter)", background: "var(--el-fill-color-lighter)" } }, [
            sectionHeading("已保存工作流", [smallButton("+", addWorkflow, { title: "新增工作流", "aria-label": "新增工作流", disabled: detecting.value })]),
            ...workflows.value.map(item => h("div", { key: item.id, class: "comfyui-workflow-item",
              style: { display: "flex", alignItems: "center", gap: "2px", marginTop: "8px", minWidth: "0" } }, [
              h("button", { disabled: detecting.value, style: { display: "block", flex: "1", minWidth: "0", padding: "9px 8px",
              border: "0", textAlign: "left", borderRadius: "5px", cursor: "pointer", overflowWrap: "anywhere", fontSize: "12px",
              background: item.id === selectedWorkflow.value ? "var(--el-color-primary-light-9)" : "transparent", color: item.id === selectedWorkflow.value ? "var(--el-color-primary)" : "inherit" },
                onClick: () => selectWorkflow(item) }, item.name),
              smallButton("×", e => { e.stopPropagation(); requestLibraryChange(item); }, { text: true, type: "danger",
                title: `删除工作流 ${item.name}`, "aria-label": `删除工作流 ${item.name}`,
                style: { flex: "0 0 24px", width: "24px", minHeight: "28px", padding: "0", margin: "0" },
                disabled: detecting.value || running.value })
            ]))
          ]),
          h("div", { class: "nodrag nopan", onClick: e => e.stopPropagation(), style: { padding: "14px", minWidth: "0", background: "var(--el-bg-color)" } }, [
            field("工作流名称", textInput(workflowName.value, e => { workflowName.value = e.target.value; }, "例如：H3 视频生成")),
            field("API Format JSON", h("textarea", { ...scrollProps, value: workflowText.value, rows: 7,
              style: { ...controlStyle, ...scrollStyle, resize: "vertical", fontFamily: "monospace", height: "160px", fontSize: "11px" }, onInput: e => { workflowText.value = e.target.value; } })),
            h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, [
              smallButton("一键检测", () => detectParameters(false), { type: "primary", plain: true, loading: detecting.value }),
              smallButton("测试连接", testConnection, { disabled: detecting.value }),
              smallButton("导入 JSON", () => fileInput.value?.click(), { disabled: detecting.value }),
              smallButton("保存工作流", saveWorkflow, { type: "primary", disabled: detecting.value }),
              smallButton("一键清空", clearEditableData, { plain: true, disabled: detecting.value || running.value }),
              ignoredParameters.value.length || ignoredBindings.value.length ? smallButton("恢复已删项", resetDetection, { text: true, disabled: detecting.value }) : null,
              h("input", { ref: fileInput, type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: importWorkflow })
            ]),
            libraryConfirmationPanel(),
            h("div", { role: "status", style: { marginTop: "10px", color: error.value || promptSyncError.value ? "var(--el-color-danger)" : "var(--el-text-color-secondary)", overflowWrap: "anywhere", fontSize: "12px" } }, promptSyncError.value || error.value || status.value),
            ...detectionNotes.value.map((note, index) => h("div", { key: index, role: "note",
              style: { marginTop: "6px", fontSize: "12px", lineHeight: "1.5", overflowWrap: "anywhere", color: "var(--el-text-color-secondary)" } }, note)),
            parameterDefinitionEditor(), bindingEditor(), outputDefinitionPanel()
          ])
        ]) : h("div", { class: "nodrag nopan", style: { padding: "12px 8px", background: "var(--el-bg-color)" } }, [
          field("工作流", selectInput(selectedWorkflow.value, [["", workflows.value.length ? "选择已保存工作流" : "暂无工作流"], ...workflows.value.map(item => [item.id, item.name])],
            e => { const item = workflows.value.find(entry => entry.id === e.target.value); if (item) selectWorkflow(item); }, { disabled: running.value })),
          h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", justifyContent: "space-between" } }, [
            referenceCounts(), smallButton(composerOpen.value ? "收起提示词" : "展开提示词", toggleComposer,
              { text: true, "aria-expanded": composerOpen.value })
          ]),
          composer(), parameterEditor(),
          h("div", { style: { display: "flex", gap: "8px", marginTop: "16px" } }, [
            smallButton(running.value ? "正在运行" : "运行", run, { type: "primary", loading: running.value, disabled: running.value || !workflowText.value }),
            smallButton("中断", stop, { disabled: !running.value })
          ]),
          runProgress.value.stage ? h("div", { class: "comfyui-run-progress", style: { marginTop: "12px" } }, [
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px 8px", justifyContent: "space-between",
              fontSize: "12px", marginBottom: "6px", overflowWrap: "anywhere" } }, [
              h("span", { style: { minWidth: 0 } }, `${runProgress.value.stage}${running.value ? " · 总进度（按节点估算）" : ""}`),
              h("strong", { style: { flexShrink: 0, fontVariantNumeric: "tabular-nums" } }, `${runProgress.value.percent}%`)
            ]),
            h("div", { role: "progressbar", "aria-label": "ComfyUI 运行进度", "aria-valuemin": 0, "aria-valuemax": 100,
              "aria-valuenow": runProgress.value.percent,
              "aria-valuetext": [runProgress.value.stage, `${runProgress.value.percent}%`, runProgress.value.nodeSummary, runProgress.value.detail].filter(Boolean).join(" · "),
              class: "comfyui-progress-track",
              style: { height: "6px", overflow: "hidden", borderRadius: "3px", background: "var(--el-fill-color-light)" } }, [
              h("div", { class: "comfyui-progress-fill", style: { height: "100%", width: `${runProgress.value.percent}%`,
                background: "var(--el-color-primary)", transition: "width 180ms ease" } })
            ]),
            runProgress.value.nodeSummary ? h("div", { class: "comfyui-progress-node", style: {
              fontSize: "12px", marginTop: "7px", overflowWrap: "anywhere" } }, runProgress.value.nodeSummary) : null,
            runProgress.value.detail ?
              h("div", { style: { fontSize: "11px", marginTop: "5px", overflowWrap: "anywhere",
                color: "var(--el-text-color-secondary)" } }, runProgress.value.detail) : null
          ]) : null,
          h("div", { role: "status", style: { marginTop: "12px", color: error.value || promptSyncError.value ? "var(--el-color-danger)" : "var(--el-text-color-secondary)", overflowWrap: "anywhere" } }, promptSyncError.value || error.value || status.value),
          promptId.value ? h("div", { style: { color: "var(--el-text-color-secondary)", marginTop: "4px", fontSize: "11px", overflowWrap: "anywhere" } }, `Prompt: ${promptId.value}`) : null
        ])
      ]) });
    }
  });
});
