# The reference MCP server cannot run as configured

Two independent defects, both verified against the running container. The
Python MCP server has never worked in this repo.

## Bug 1 — the module fails at import

`app/mcp_server.py:29` does:

```python
from mcp.server import Server
```

That resolves to `mcp.server.lowlevel.server.Server`. The environment has
**mcp 2.3.0** installed (via an unpinned `mcp` in `requirements.txt`), and that
class has neither `list_tools` nor `call_tool`:

```
AttributeError: 'Server' object has no attribute 'list_tools'
```

It fails on the `@server.list_tools()` decorator — before any request is
served. The file was written against the ≤1.x decorator API; 2.3.0 does not
have it. Nothing in the repo pins the version, so any fresh install breaks it.

## Bug 2 — `list_stacks` would raise anyway

`app/mcp_server.py:195` calls `await _list_stacks()`, while the handler at
`:336` is declared `async def _list_stacks(args: dict)`. Every invocation
raises TypeError.

## Consequence for the TypeScript port

There is no working Python oracle for any of the four MCP tools, because the
process cannot start. The port therefore cannot be validated by differential
against a running reference the way the HTTP endpoints were.

What the port does instead, and why it is still verifiable:

- The **formatters** are pure functions of JSON. They were goldened by
  executing the real CPython functions directly, outside the broken server, and
  compared byte-for-byte. That path does not require the MCP runtime.
- The **tool advertisement** was extracted from the Python source and asserted
  field by field.
- **Routing and headers** were verified against a recording stub, then through
  a real stdio handshake with the SDK's own client over a child-process pipe.

The port intentionally implements the working intent of `list_stacks` (passing
`arguments` through) rather than reproducing the TypeError. That is a
deliberate divergence, documented in `ts/src/mcp.ts`.

## Note on the tool count

The module docstring says "Three tools exposed". `list_tools()` advertises
four, including `list_stacks`. The docstring is stale; four is correct.

## Why this matters beyond the port

It is a defect in the reference implementation, independent of this migration.
Anyone following the README to connect Claude Desktop would hit an import
error, not a working MCP server.
