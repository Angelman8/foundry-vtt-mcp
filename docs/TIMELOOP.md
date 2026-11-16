# Timeloop tools

This fork adds MCP tools for the Timeloop Foundry VTT module, plus a generic `update-scene` tool. The Timeloop tools need the Timeloop module to be active in the world. Without it they return `Timeloop no-timeloop: ...`.

Each tool is a thin call into `game.modules.get("timeloop").api` (API version 1) through the bridge module. All validation and timeline logic stays in Timeloop. Every Timeloop tool takes an optional `scene` (id or name); the default is the scene the Timeloop clock is running on. The tools are GM only.

Times are loop seconds or a clock string (`"09:30"`, `"09:30:15"`). Durations are a number of seconds, or text such as `"3m 20s"` or `"90s"` (a bare number in text means minutes). A path reference is an id or name, `{token}`, `{wall}`, `{light}`, `{tile}`, `{actor}`, `{darkness: true}`, or `"cues"`. A change reference is an index, `{time}`, or a cue id.

## Tools

| Tool | Example call |
|---|---|
| `timeloop-get` | `{"what": "paths"}` (also `clock`, `path` with `path`, `state` with `time`) |
| `timeloop-create-path` | `{"token": "Thief"}` (or `wall`, `light`, `tile` id, or `"darkness": true`) |
| `timeloop-edit-path` | `{"operation": "rename", "path": "Thief", "name": "Burglar"}` |
| `timeloop-add-change` | `{"path": "Thief", "change": {"time": "09:30", "path": [{"x": 500, "y": 500}], "duration": "20s"}}` |
| `timeloop-edit-change` | `{"operation": "retime", "path": "Thief", "change": {"time": "09:30"}, "time": "09:45"}` |
| `timeloop-cue` | `{"operation": "add", "cue": {"type": "chat", "text": "The bell tolls."}, "time": "10:00"}` |
| `timeloop-presence` | `{"operation": "spawn", "token": "Thief", "time": "09:30", "at": {"x": 300, "y": 300}}` |
| `timeloop-clock` | `{"operation": "tick", "duration": "5m"}` (also `jump`, `next`, `previous`, `reset`, `resume`) |
| `timeloop-export` | `{"file": "C:\\exports\\inn.json"}` writes the file and returns `{file, summary}` |
| `timeloop-import` | `{"file": "C:\\exports\\inn.json", "scene": "Inn copy"}` |
| `update-scene` | `{"scene_identifier": "Inn", "updates": {"background.src": "maps/inn.webp"}}` |

Notes:

- `timeloop-import` replaces the scene's timeline without asking, and macro cues in the file run as the GM.
- `update-scene` refuses embedded documents (tokens, walls, lights, sounds, tiles, notes, drawings, templates, regions), `_id`, `_stats`, `folder`, `ownership` and `flags.core` (dotted or nested), and Foundry's `-=` / `==` key operators. It dry-runs the update first, so invalid data comes back as an error, and returns the resolved diff as `changed`.
- Errors come back as `Timeloop <code>: <message>`, for example `Timeloop not-found: ...`.

## Build and install

Requires Node and npm.

```
npm install
npm run build:release
```

Install, replacing the upstream bridge and server with the fork's:

1. Move the installed bridge folder (`Data/modules/foundry-mcp-bridge`) somewhere safe.
2. Junction or copy `packages/foundry-module` (with its built `dist/`, `module.json`, `lang`, `styles` and `templates`) to `Data/modules/foundry-mcp-bridge`.
3. Point the MCP client's server entry at `packages/mcp-server/dist/index.bundle.cjs` (it starts `backend.bundle.cjs` next to it), started with the same `node`.
4. Do not run the upstream installer while using the fork; an upstream update would replace the junction.

Reload Foundry afterwards. The existing tools keep working.
