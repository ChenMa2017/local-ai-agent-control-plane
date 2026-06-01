# 09. GitHub SSH

Check for existing keys:

```bash
ls -la ~/.ssh
```

Generate a GitHub key if needed:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C "your-email@example.com" -f ~/.ssh/id_ed25519_github
```

Add SSH config:

```text
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
```

Permissions:

```bash
chmod 600 ~/.ssh/id_ed25519_github
chmod 644 ~/.ssh/id_ed25519_github.pub
chmod 600 ~/.ssh/config
```

Copy the public key:

```bash
cat ~/.ssh/id_ed25519_github.pub
```

Add it to GitHub:

```text
GitHub -> Settings -> SSH and GPG keys -> New SSH key
```

Test:

```bash
ssh -T git@github.com
```

Expected:

```text
Hi <username>! You've successfully authenticated, but GitHub does not provide shell access.
```

Push:

```bash
git remote add origin git@github.com:<your-user>/<your-repo>.git
git push -u origin main
```
