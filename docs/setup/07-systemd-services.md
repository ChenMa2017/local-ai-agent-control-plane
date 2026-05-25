# 07. systemd User Services

Service templates:

```text
systemd/user/agent-host-web.service
systemd/user/discord-agent-adapter.service
```

Install:

```bash
cd /home/chenma/Documents/My_App_Dev/local-ai-agent-control-plane
scripts/install_user_services.sh
```

Start:

```bash
systemctl --user start agent-host-web.service
systemctl --user start discord-agent-adapter.service
```

Status:

```bash
scripts/status_services.sh
```

Logs:

```bash
scripts/tail_logs.sh
scripts/tail_logs.sh agent
scripts/tail_logs.sh discord
```

Restart after code/config changes:

```bash
systemctl --user restart agent-host-web.service
systemctl --user restart discord-agent-adapter.service
```

Enable at login:

```bash
systemctl --user enable agent-host-web.service
systemctl --user enable discord-agent-adapter.service
```

If you want user services to survive logout:

```bash
loginctl enable-linger "$USER"
```

Security checks:

```bash
journalctl --user -u agent-host-web.service -n 300 --no-pager | grep -E "TOKEN|Bearer|sk-|ghp_"
journalctl --user -u discord-agent-adapter.service -n 300 --no-pager | grep -E "TOKEN|Bearer|sk-|ghp_"
```

It is acceptable to log that a token variable is present. It is not acceptable to log the token value.
