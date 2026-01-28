# jlceda-schematic-helper

嘉立创 EDA Pro（v3.2.x）原理图辅助工具：由 **EDA 扩展桥（.eext）** + **MCP Server（npm 包，可用 `npx` 启动）** 两部分组成。

目标：让 LLM 通过 MCP tools 访问本机的嘉立创 EDA，完成元器件搜索/选型/数据手册导出，以及网表（`.enet`）导出并转为结构化 JSON 供 LLM 读取。

## 组件

- `packages/eda-extension/`：JLCEDA Pro 扩展（桥接 WebSocket，执行 EDA API 调用），产物 `.eext`
- `packages/mcp-server/`：MCP Server（npm 包名 `jlceda-schematic-helper`，提供 `stdio` MCP tools，同时监听本机 WebSocket 供扩展连接）

## 环境要求

- Node.js >= 20
- 嘉立创 EDA 专业版（建议：v3.2.84）
## 快速开始
```
{
  "mcpServers": {
    "jlceda-schematic-helper": {
      "command": "npx",
      "args": ["-y", "jlceda-schematic-helper@latest", "--port", "9050"],
      "env": {}
    }
  }
}

```
## 快速开始（本地开发）

1) 安装依赖并构建：

```bash
npm ci
npm run build
```

2) 启动本机 WebSocket/MCP Server（开发态直接跑 dist）：

```bash
node packages/mcp-server/dist/cli.js --port 9050
```

3) 在 JLCEDA Pro 中安装扩展：

- 构建产物位于：`packages/eda-extension/build/dist/*.eext`
- 安装后给扩展开启（尽量）完整权限（尤其是“外部交互”）
- 扩展默认会自动连接 `ws://127.0.0.1:9050`（可在扩展菜单里改 URL/开关自动连接）

## 作为 MCP Server 使用（LLM 侧）

发布后可直接用 `npx` 启动：

```bash
npx jlceda-schematic-helper@latest --port 9050
```

然后在 MCP Client 配置中把该命令作为 `stdio` server 启动即可。

## 已有 Tools（v0.x）

> 以当前实现为准：`packages/mcp-server/src/tools/toolRegistry.ts`

- `jlc.status`：桥接状态（是否已连接到 EDA 扩展）
- `jlc.bridge.ping`：对扩展 ping
- `jlc.bridge.show_message`：在 EDA 内弹 toast
- `jlc.schematic.get_enet_json`：获取网表并解析为结构化 JSON（支持 `detail`/`limits`/`includeRaw` 放缩输出）
- `jlc.schematic.export_enet`：导出网表文本到本地文件（可选解析）

示例（本地 CLI tool 模式）：

```bash
node packages/mcp-server/dist/cli.js --port 9050 --tool jlc.schematic.get_enet_json --params '{"netlistType":"EasyEDA","detail":"standard","includeRaw":false}'
```


