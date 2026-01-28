# jlc-schematic-helper 开发计划（MCP）

## 0. 项目评估（当前仓库现状）

- 当前工作区 `g:\jlc-schematic-helper` 已搭建为 monorepo（workspaces），核心目录：
  - `packages/eda-extension/`：嘉立创 EDA Pro `v3.2.84` 扩展桥（产物 `.eext`）
  - `packages/mcp-server/`：MCP Server（npm 包名 `jlceda-schematic-helper`）+ 本机 WebSocket Bridge
  - `docs/`：项目文档（计划/使用说明/工具清单）
  - `reference-readonly/`：参考实现（只读）
- 当前进度（已验证可用）：WS hello/ping 通路；`schematic.getNetlist` 拉取网表文本；`jlc.schematic.get_enet_json` 将 JLCEDA/EasyEDA 的 `.enet` JSON 网表解析为 LLM 友好的结构化输出（支持 `detail`/`limits`/`includeRaw`）。
- 结论：后续迭代重点放在 **npm/MCP server 侧**（解析/筛选/选型/下载），扩展侧保持“薄 + 稳定”。

## 1. 目标与交付物

分两部分交付：

1) **嘉立创 EDA 侧扩展（MCP Bridge）**
- 作用：在 EDA 进程内调用 EDA API；通过 WebSocket 连接本机 MCP Server，执行 RPC 请求。
- 目标 EDA：嘉立创 EDA 专业版 `v3.2.84`。
- 编译产物：`.eext`。

2) **npm 包（MCP Server 本体）**
- 作用：以 `stdio` 方式提供 MCP tools（供 LLM 调用），同时在本机监听 WebSocket 供 EDA 扩展连接。
- 使用方式：`npx jlceda-schematic-helper ...` 启动（例如 `--port 9050`），LLM 侧通过 MCP 客户端配置调用。

必须实现的能力：
- 元器件搜索
- 选型（在给定约束下返回候选器件/推荐）
- 数据手册导出（URL + 下载 PDF 到本地文件）
- 网表导出：从 EDA 导出 `.enet`，并转换为 JSON 返回给 MCP 对端 LLM 使用

## 2. 参考实现（reference-readonly）对齐点

直接复用其成熟思路（不复用代码文件结构也可以照搬关键模块设计）：

- **桥接架构**：MCP Server 本机监听 WebSocket；EDA 扩展作为客户端连接；MCP Server 通过 RPC 调用扩展能力。
- **协议**：hello + request/response（见 `reference-readonly/jlc-eda-mcp/docs/PROTOCOL.md`）。
- **扩展构建**：esbuild bundle + zip 打包生成扩展产物（参考 `reference-readonly/jlc-eda-mcp/packages/eda-extension`）。
- **MCP server**：`@modelcontextprotocol/sdk` + toolRegistry（参考 `reference-readonly/jlc-eda-mcp/packages/mcp-server`）。

## 3. 总体架构（本项目）

```
LLM (MCP Client)
  └─ stdio ──> MCP Server (npm package, Node.js)
               ├─ Tools: parts search/selection/datasheet/netlist
               ├─ WebSocket Server (127.0.0.1)
               └─ RPC -> EDA Extension (Bridge)
                             └─ calls EDA APIs (export .enet / export doc / etc.)
```

设计原则：
- WebSocket 仅绑定 `127.0.0.1`（本地桥接）。
- RPC/工具输出尽量“LLM 友好”：结构化 JSON、字段稳定、可截断（maxChars/maxItems）。
- EDA 侧只负责“调用 EDA API + 文件导出/读取”；解析与转换尽量放在 MCP Server 侧（便于测试与迭代）。

## 3.1 迭代与发布策略（重点服务端）

- 扩展侧（`.eext`）：尽量“薄 + 稳定”，一次性开足所需权限（例如“外部交互”等），后续低频更新；只在 EDA API 变更/需要新增底层能力时升级。
- 服务端（npm 包）：作为主要迭代点，承载数据源对接（EDA+在线）、解析/筛选/放缩、选型逻辑、数据手册下载等；每次通过 `npx jlceda-schematic-helper@latest ...` 拉取最新版本快速迭代。
- 生产/可复现：建议在 MCP 客户端配置里“锁版本号”，避免 `@latest` 引入不可预期变更（开发阶段用 `@latest`）。

## 4. 工程结构规划（建议 monorepo）

```
/
  package.json                  # workspaces
  packages/
    mcp-server/                 # npm 包：MCP Server + ws bridge
    eda-extension/              # EDA 扩展：ws client + RPC handlers
  docs/
    plan.md
    setup.md                    # 安装/运行/排障
    tools.md                    # MCP tools 清单与示例
  scripts/
    sync-versions.mjs           # 可选：同步版本号
```

技术选型（与参考实现保持一致，降低风险）：
- TypeScript + Node >= 20
- `@modelcontextprotocol/sdk`（MCP server）
- `ws`（WebSocket server/client）
- `zod`（入参校验 + 输出结构约束）
- 扩展侧：按 `pro-api-sdk` 的 esbuild 方式打包

## 5. MCP Tools 设计（v1）

### 5.1 元器件搜索/选型/数据手册

说明：器件数据来源有两条路（可并行支持）：
- A. **EDA 内置库**：通过扩展调用 `eda.lib_Device.search/get`（参考实现已有）。优点：不依赖外部网络；缺点：字段可能不含采购信息/数据手册不完整。
- B. **在线器件数据源**：通过 MCP Server 直接 HTTP 查询（例如 LCSC/JLC 相关接口）。优点：更贴近采购选型；缺点：接口稳定性与限流不确定。

v1 要求：A + B 都要做，并支持合并/对齐（便于选型与采购）。

工具草案（最终名称可调整）：
- `jlc.parts.search`
  - 输入：`{ query, limit?, page?, source?: "eda"|"online"|"auto"|"merge" }`
  - 输出：`{ source, items: [{ id, name, mpn?, manufacturer?, package?, summary?, datasheetUrl? , ... }] }`
  - 说明：`merge` 优先以 `mpn/lcsc` 等标识做去重与字段补全（EDA 缺的 datasheet/采购字段用 online 补齐）。

- `jlc.parts.pick`
  - 输入：`{ query, constraints?: { package?, voltage?, current?, tolerance?, tempco?, ... }, limit? }`
  - 输出：`{ picks: [{ reason, item }] }`
  - 注：该工具不做“LLM 推理替代”，只做可解释的规则/排序（如优先现货、优先常用封装、优先有 datasheet）。

- `jlc.datasheet.get`
  - 输入：`{ id? , datasheetUrl? }`
  - 输出：`{ url, fileName?, mime?, sizeBytes? }`（不落盘）

- `jlc.datasheet.download_pdf`
  - 输入：`{ url, savePath?, fileName?, force? }`
  - 输出：`{ url, savedTo, fileName }`

### 5.2 网表（.enet）导出与 JSON 转换

工具草案：
- `jlc.schematic.export_enet`
  - 输入：`{ savePath?, fileName?, force?, detail?: "summary"|"standard"|"full", include?: { nets?: boolean, nodes?: boolean, components?: boolean, pins?: boolean, bomFields?: boolean, footprints?: boolean, datasheets?: boolean, raw?: boolean }, limits?: { maxNets?: number, maxNodesPerNet?: number, maxComponents?: number, maxPinsPerComponent?: number, maxCharsRaw?: number } }`
  - 行为：通过桥接扩展调用 EDA 导出 `.enet` 到本地；MCP Server 读取文件并返回解析结果（JSON）。
  - 输出：`{ savedTo?, fileName, parsed: {...}, raw?: { truncated, totalChars } }`
  - 说明：LLM 可通过 `detail/include/limits` “放缩”导出网表详细程度；默认 `standard`，并对 `raw` 做截断保护。

- `jlc.schematic.get_enet_json`
  - 输入：`{ detail?: "summary"|"standard"|"full", include?: { nets?: boolean, nodes?: boolean, components?: boolean, pins?: boolean, bomFields?: boolean, footprints?: boolean, datasheets?: boolean, raw?: boolean }, limits?: { maxNets?: number, maxNodesPerNet?: number, maxComponents?: number, maxPinsPerComponent?: number, maxCharsRaw?: number } }`
  - 输出：结构化 JSON（不强制落盘；如 EDA API 必须落盘则内部落盘再读取）。

`.enet -> JSON` 的 v1 目标结构（具体以样例文件落地后调整）：
```jsonc
{
  "format": "enet",
  "meta": { "generatedAt": "ISO", "sourceFile": "path", "edaVersion?": "..." },
  "components": [
    { "ref": "R1", "value?": "10k", "footprint?": "0603", "mpn?": "...", "lcsc?": "Cxxxx", "pins": [{ "pin": "1", "net": "NET1" }] }
  ],
  "nets": [
    { "name": "GND", "nodes": [{ "ref": "U1", "pin": "1" }, { "ref": "C1", "pin": "2" }] }
  ],
  "warnings": []
}
```

## 6. EDA 扩展侧（Bridge）规划

扩展提供最小 RPC 方法集：
- `ping` / `getStatus`（连通性与状态）
- `library.searchDevices` / `library.getDevice`（如果采用 EDA 内置库作为数据源）
- `schematic.exportEnetFile`（关键：导出 `.enet`）
  - 优先：调用 EDA 提供的“网表/工程数据导出 API”（需要调研具体函数名/参数）
  - 兜底：若只能导出其它网表格式，则先导出可得文件，再在 server 侧转换为等价 JSON

扩展 UI：
- 顶部菜单：`MCP Bridge -> Configure / Connect / Disconnect`
- 配置项：`serverUrl`（默认 `ws://127.0.0.1:9050`）

打包产物：
- 已确认：扩展包后缀为 `.eext`；目标 EDA 版本 `v3.2.84`。
- 实施时需设置 `extension.json.engines.eda` 覆盖 `3.2.x`（避免版本范围不匹配导致扩展不可用）。

## 7. 关键不确定项与调研任务（必须先做）

1) **`.enet` 文件格式与导出 API**
- 需要在 EDA 内手动导出一个最小工程 `.enet` 样例，放入（未来的）`fixtures/` 作为解析测试输入。
- 需要确认 EDA API 是否能：
  - 直接导出 `.enet`
  - 或导出等价内容（例如 netlist 文本/其它格式）再转换

2) **器件数据源合并策略**
- 在线数据：需要确定可用的查询接口、限流策略、字段完整性（datasheet URL/PDF）。
- EDA 内置库：需要确认 `eda.lib_Device.get` 返回的字段（是否含 datasheet/封装/属性字段）。
- 合并：定义主键优先级（如 `lcsc > mpn > manufacturer+mpn > name+package`）与冲突解决规则。

## 8. 实施里程碑（建议按阶段验收）

### P0：骨架与跑通链路（“能连上”）
- 建立 monorepo/workspaces、基础 lint/typecheck/build 脚本
- MCP Server：启动 `stdio` + WebSocket 监听；提供 `jlc.status/jlc.bridge.ping`
- EDA 扩展：可配置并连接 ws；能响应 `ping`
- 验收：LLM 侧能通过 MCP 调用 `jlc.bridge.ping` 得到来自扩展的回包

### P1：网表导出（“.enet 文件能出来”）
- 扩展侧实现 `schematic.exportEnetFile`（或等价导出）
- server 侧实现 `jlc.schematic.export_enet`：能拿到 `savedTo`
- 验收：对任意打开的原理图页，能导出 `.enet` 到指定目录

### P2：.enet 解析与 JSON 输出（“LLM 能读懂”）
- 建立 `enet` parser（纯 TS），支持核心字段：nets + nodes（Ref/Pin）
- 为 parser 增加 fixtures + 单元测试
- MCP tool `jlc.schematic.get_enet_json` 支持截断参数
- 验收：对 fixtures 样例与真实导出文件，JSON 能稳定产出且字段不漂移

### P3：器件搜索/选型/数据手册（“能查 + 能下”）
- 实现 `jlc.parts.search`（至少 EDA 内置库）
- 实现 `jlc.datasheet.get` / `download_pdf`
- 可选：实现 `jlc.parts.pick` 的简单规则排序
- 验收：给定关键字能返回候选器件；能拿到 datasheet URL；能下载 PDF 到本地

## 9. 文档与示例（同步产出）

- `docs/setup.md`：安装、构建、启动 server、安装扩展、连接与排障
- `docs/tools.md`：tools 列表、每个 tool 的输入/输出样例
- 提供 MCP 客户端配置示例（npx 启动）

## 10. 下一步（需要你确认/提供的信息）

已确认：
- 目标 EDA：嘉立创 EDA 专业版 `v3.2.84`
- 扩展产物：`.eext`
- 网表 JSON：需要“全量”，并允许 LLM 通过参数控制导出粒度
- 器件数据：EDA 内置库 + 在线数据都要，用于选型
- npm 包名：`jlceda-schematic-helper`
