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

## Notes

- The JLCEDA extension bridge should connect to `ws://127.0.0.1:9050` (default).
- This package exposes a CLI binary named `jlceda-schematic-helper`.

