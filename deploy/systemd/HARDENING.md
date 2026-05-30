# Dilla systemd unit — directive rationale

Quick reference for each hardening directive in `dilla-server.service`. If you
need to relax one, check this file first — most are listed in the [systemd
"safe enough" tier on Lennart's exposure table][exposure] and removing them is
a net loss.

[exposure]: https://0pointer.net/blog/projects/security.html

## Identity

| Directive | Why |
|---|---|
| `User=dilla` / `Group=dilla` | A dedicated unprivileged uid means a compromised dilla-server cannot read other users' homedirs even if `ProtectHome` is bypassed by a kernel bug. |
| `PrivateUsers=true` | The unit runs in its own user namespace; uid 0 inside the namespace maps to nobody outside. Defense in depth in case a syscall slips through the filter. |

## Filesystem

| Directive | Why |
|---|---|
| `ProtectSystem=strict` | The entire filesystem is mounted read-only EXCEPT `ReadWritePaths`. A compromised dilla cannot tamper with `/usr/local/bin/dilla-server` even if it gets uid 0 in the namespace. |
| `ProtectHome=true` | `/root`, `/home`, `/run/user` are made inaccessible. We never need them. |
| `ReadWritePaths=/var/lib/dilla` | Only place we need to write. SQLCipher DB + uploads + `audit_events` cursor. |
| `PrivateTmp=true` | Fresh `/tmp` per invocation. No cross-process tmpfile injection. |
| `PrivateDevices=true` | No `/dev/*` other than the standard PTY + null/zero/random. We never touch hardware. |
| `ProtectProc=invisible` + `ProcSubset=pid` | `/proc/<other-pid>/` is hidden. Information disclosure on a shared host is reduced. |
| `ProtectKernel{Tunables,Modules,Logs}=true` | We never write to `/proc/sys`, never `modprobe`, never read kernel ring buffer. |
| `ProtectControlGroups=true` | We don't manipulate cgroups. |
| `ProtectClock=true` | We don't `clock_settime`. |
| `ProtectHostname=true` | We don't `sethostname`. Reading is still allowed. |

## Privilege

| Directive | Why |
|---|---|
| `NoNewPrivileges=true` | `setuid`/`setgid`/`fcaps` cannot grant new privs. Hard-required for the seccomp filter to mean anything. |
| `CapabilityBoundingSet=` (empty) | Dilla needs zero capabilities. Port 8080 doesn't require `CAP_NET_BIND_SERVICE`; the reverse proxy handles 80/443. |
| `AmbientCapabilities=` (empty) | No caps passed to children either. |
| `RestrictSUIDSGID=true` | Dilla never creates setuid/setgid files. Reject the attempt. |
| `LockPersonality=true` | Block `personality(2)` — used by some exploits to enable ancient ABI quirks. |
| `MemoryDenyWriteExecute=true` | No W^X violations. webrtc-rs and rustls do NOT use a JIT, so this is safe. **If you add a Wasm runtime with JIT, you must remove this.** |
| `RestrictRealtime=true` | No `SCHED_FIFO`/`SCHED_RR`. Removes a DoS-via-RT-priority vector. |
| `RestrictNamespaces=true` | We can't create new mount/net/user/pid namespaces. Confines container-escape primitives. |

## Network

| Directive | Why |
|---|---|
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` | No `AF_NETLINK` (no route table snooping), no `AF_PACKET` (no raw sockets), no `AF_BLUETOOTH`, etc. |
| `IPAddressDeny=any` + selective `IPAddressAllow` | Cgroup-level egress filter. Pairs with the userspace egress allow-list (R-19) but works even if the binary is bypassed. **Tighten further if you don't federate or use Giphy.** |

## Syscalls

| Directive | Why |
|---|---|
| `SystemCallFilter=@system-service` | The standard server allow-list (~370 syscalls). Includes file I/O, sockets, time, signals. |
| `SystemCallFilter=~@debug @mount @reboot @swap @raw-io @cpu-emulation @obsolete` | Explicit deny for syscall groups we never need. `~@debug` blocks `ptrace`/`process_vm_readv` — anti-debugging by default. |
| `SystemCallErrorNumber=EPERM` | Return `EPERM` to blocked syscalls instead of killing the process with `SIGSYS`. Tradeoff: noisier logs in exchange for resilience. Some operators prefer `SIGSYS` for stricter posture — change here if you want that. |
| `SystemCallArchitectures=native` | Block all non-native syscall tables (x32, ia32 on x86_64). Closes the "32-bit syscall confusion" exploit class. |

## Resources

| Directive | Why |
|---|---|
| `LimitNOFILE=65536` | High enough for thousands of WS connections + the SQLCipher WAL fds. |
| `LimitNPROC=4096` | Plenty for tokio's worker pool. Fork-bomb cap. |
| `MemoryMax=2G` / `MemoryHigh=1500M` | Soft + hard memory cap. The OOM-killer will hit dilla-server before it OOMs the host. |

## Credentials

`LoadCredential=db-passphrase:/etc/dilla/db-passphrase` mounts the secret at
`/run/credentials/dilla-server.service/db-passphrase` — owned by the unit
user, mode 0400, bind-mounted from a `tmpfs`. The path is exposed via the
`%d` specifier (`Environment=DILLA_DB_PASSPHRASE_FILE=%d/db-passphrase`).

Advantages over `Environment=DILLA_DB_PASSPHRASE=...`:

- Not visible in `/proc/<pid>/environ` (env vars are world-readable on Linux).
- Not in `systemctl show dilla-server` output.
- Survives `journalctl --output=verbose` without leaking.
- Auto-zeroized on unit stop.

## What this unit does NOT protect against

- **A bug in dilla-server itself that exfiltrates DB rows via legitimate HTTP responses.** That's an authorization problem (covered by R-03 / R-18), not a sandbox problem.
- **A subverted SQLCipher DB on disk.** The unit lets dilla read its own DB — if an attacker swaps the file out before start, dilla will happily decrypt it. Use full-disk encryption on the host AND verify the dilla user is the only one with write access.
- **A malicious reverse proxy.** dilla trusts the `X-Forwarded-For` header from `DILLA_TRUSTED_PROXIES`. If your proxy host is compromised, attackers can spoof source IPs. Treat the proxy as the same security tier as dilla.
