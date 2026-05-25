# 05. Host Ops Setup

Path:

```text
modules/host-ops
```

Purpose:

```text
Read-only host sensor layer.
```

It is not a remote shell.

Allowed commands:

```text
capabilities
systemd-user-status
systemd-user-list-timers
journal-tail
disk-usage
git-status
```

Check:

```bash
cd /home/chenma/Documents/My_App_Dev/local-ai-agent-control-plane/modules/host-ops
python3 -m unittest discover -s tests
python3 host_ops.py capabilities
```

Examples:

```bash
python3 host_ops.py systemd-user-status agent-host-web.service
python3 host_ops.py systemd-user-status discord-agent-adapter.service
python3 host_ops.py systemd-user-list-timers
python3 host_ops.py journal-tail discord-agent-adapter.service --lines 80
python3 host_ops.py disk-usage my_ai_agent
python3 host_ops.py git-status host_ops
```

Forbidden:

```text
arbitrary shell
sudo
restart / stop / kill service
delete files
chmod / chown
package install
network fetch
dataset modification
```

Current status:

```text
Standalone CLI MVP.
Not yet exposed through Agent Host API.
Not exposed to Discord.
```
