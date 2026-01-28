# jlceda-schematic-helper (MCP Server)

MCP server that drives **JLCEDA Pro local client** via a local **.eext extension bridge** (WebSocket).

## Usage

Start the server (LLM/MCP client should run this as a `stdio` server):
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
only for dev:
```bash
npx jlceda-schematic-helper@latest --port 9050
```

During development (from repo root):

```bash
node packages/mcp-server/dist/cli.js --port 9050
```

## Tools

- `jlc.status`: bridge status (listening port + EDA connection state)
- `jlc.bridge.ping`: ping EDA extension
- `jlc.bridge.show_message`: show a toast in EDA
- `jlc.schematic.get_enet_json`: export `.enet` and convert to JSON (supports `detail` / `limits` / `includeRaw`)
- `jlc.schematic.export_enet`: export netlist text to a local file (optional parse)
- `jlc.library.search_devices`: search the built-in EDA device library (raw)
- `jlc.library.get_device`: get device detail by `deviceUuid` (raw)
- `jlc.parts.search`: search candidate parts (extracts `datasheetUrl` when possible)
- `jlc.parts.pick`: rank/pick candidate parts (simple rules + reasons)
- `jlc.parts.get_datasheet`: resolve datasheet URL + PDF URL; optionally download the PDF

### Parts selection workflow (typical)

1) Find candidates:

```bash
node packages/mcp-server/dist/cli.js --port 9050 --tool jlc.parts.pick --params-file artifacts/params.json
```

`artifacts/params.json` example:
```json
{
  "fromComponent": { "value": "10uF", "footprintName": "C0603" },
  "limit": 5,
  "requireDatasheet": true
}
```

2) Get datasheet URL/PDF (and optionally download):

```json
{
  "url": "https://item.szlcsc.com/datasheet/XXX/YYY.html",
  "download": true
}
```

## Notes

- The JLCEDA extension bridge should connect to `ws://127.0.0.1:9050` (default).
- This package exposes a CLI binary named `jlceda-schematic-helper`.
