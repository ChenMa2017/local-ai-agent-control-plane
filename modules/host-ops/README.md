# Host Ops

`host_ops` is a read-only sensor layer for the local Agent Host. It gives
`main_codex` a safe way to inspect a small allowlisted set of host state without
turning Discord, Web UI, or Codex into a remote shell.

## Safety Boundary

Allowed:

- user systemd service status for allowlisted units;
- user systemd timer listing;
- journal tail for allowlisted units;
- disk usage for allowlisted path aliases;
- git status for allowlisted workspaces.

Forbidden:

- arbitrary shell;
- `sudo`;
- service restart/stop/kill;
- file deletion;
- chmod/chown;
- package installation;
- network fetches;
- dataset modification.

## Usage

```bash
cd $HOME/Documents/My_App_Dev/host_ops
python3 host_ops.py capabilities
python3 host_ops.py systemd-user-status agent-host-web.service
python3 host_ops.py systemd-user-status discord-agent-adapter.service
python3 host_ops.py systemd-user-list-timers
python3 host_ops.py journal-tail discord-agent-adapter.service --lines 80
python3 host_ops.py disk-usage my_ai_agent
python3 host_ops.py git-status discord_agent_adapter
```

All commands return JSON. Outputs are bounded and sanitized.

## Configuration

Copy the example if a local override is needed:

```bash
cp host_ops.config.example.json host_ops.config.json
```

`host_ops.config.json` is ignored by git so machine-specific allowlists can stay
local.

## Tests

```bash
python3 -m py_compile host_ops.py tests/test_host_ops.py
python3 -m unittest discover -s tests
```

