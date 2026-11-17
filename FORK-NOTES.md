# Fura fork notes

Behaviour this fork (`fulara/oh-my-pi`, branch `fork-stuff`) carries on top of upstream
`can1357/oh-my-pi`. Upstream `CHANGELOG.md` files stay byte-identical to upstream so
rebases never conflict there; record fork changes here instead.

Add a bullet to the package section when a fork commit changes behaviour; remove it when
the patch is dropped or upstream supersedes it.

## coding-agent

- Fura fork: on OMP 18.20, the WebKit host kill uses the process identity pinned at spawn and a headless-browser close timeout uses one pinned before closing (only for this host's own child); the `ptree` subreaper fallback signals only through its own child handle, `ptree` cleanup reports instead of retrying by PID/group when that identity is missing or refused, and the isolated process-safety regression probe runs under its renamed `proctree` module.
- Fura fork: `timeout -k` escalates only to externals whose start time still matches the one pinned at spawn, so a reused PID is never killed.
- Fura fork: a queued extension message that waits for preprocessing now reports itself to `onPromptQueued`, so a failed post-compaction flush that restores its batch also takes it back out of the session queue instead of sending it twice.
- Fura fork: disposing a session also drops the leaf entry cached by session skills, so a disposed session no longer keeps its last reply (and transcript) in memory.
- Fura fork: native `grep -m` again finishes on a live pipe once its limit and trailing context are met, and `-m0` exits without reading, on the reworked upstream push search.
- Fura fork: native `rg -m` likewise finishes on a live pipe (e.g. `yes | rg -m1 y`) once its limit and trailing context are met, including PCRE2 (`-P`) searches, and `-m0` (also with `-U`) exits without reading; the vendored `grep-searcher` push search stops itself once the limit leaves nothing to report.
- Fura's source-pinned idle recap owner remains the only generator for the main TUI session while upstream idle compaction keeps its queue and background-work barriers.
- Fixed cancellable FIFO readers hanging at EOF on Darwin, including background shell redirects and readers resumed after a timeout; high-numbered descriptors retain cancellation support.
- Fura fork: added `get_pending_messages` and `remove_pending_messages` RPC/SDK operations with generation guards, original text/image previews and exact-input removal receipts that do not abort or settle an active turn.
- Preserved Fura's RPC extensions in the generated wire schema and Python/Rust/Go clients, including lossless branch images and guarded pending-input removal.
- Fura fork: retain spawn-pinned ownership for background shell jobs across runs while preserving TERM cleanup grace; keep queued session-agent notices attached to their removable prompt.
- RPC `prompt`, `steer`, and `follow_up` accept optional `clientMessageId` metadata that survives queued consumption, skill expansion, and persisted replay.
- Added durable session-skill selection through `get_session_skills` / `set_session_skills`: pinned definitions, revision-checked Apply, captured main/BTW request context, and branch-aware restore without extra transcript messages or model calls on selection.
- Fura fork: retained durable RPC prompt identity, session skills, BTW transition ownership and session activity/recaps on OMP 18.3.3, alongside upstream's batched rewind results and MCP structured-result persistence.
- RPC now emits `session_settled` when an async-wait delivery drains without waking the agent; an older drain cannot settle a newer continuation.
- Fura fork: shared TUI/RPC idle recaps react to settings changes after a terminal settle without duplicating a delivered recap; pending/in-flight work remains guarded against queues, compaction, drafts and stale session provenance.
- Generated Python, Go and Rust `btw_cancel` APIs now accept optional `btwId`/`recordId` selectors and return the selected response envelope rather than an unwrapped upstream boolean. Python callers use keyword selectors; Go/Rust callers use optional fields and inspect `cancelled` or `btwId`.
- Kept Fura's isolated BTW cancellation and upstream persisted-topic cancellation distinct by selector, including queued cancellation during maintenance; ambiguous selectors fail without cancelling a pending snapshot.
- Kept ACP mid-turn steering admission, permission-dialog wakeups and explicit pending-input removal compatible after the Fura fork refresh.
- Supervised process launch refuses a native addon without the fork's process-identity API before starting a child, avoiding untracked processes when source and addon builds differ.
- Distinct correlated user submissions with identical timestamps and content remain separate in persisted history.
- Daemon recovery requires the persisted native process identity before adopting or stopping a process. Unverifiable resources remain visible and unmanaged across broker restarts; lifecycle commands refuse to control them.
- Eval kernel shutdown retains process identities before polite exit and cleans up owned descendants without signalling stale process groups; interpreter probes use the same guarded process utility.
- Isolated explicitly launched browser applications from the caller's process group; browser and sign-in cleanup now retain startup native ownership and original child exit proof, refuse missing ownership, and never recapture a PID or terminate a borrowed browser.
- Preserved pinned process ownership during broken-pipe retirement; kernel regressions now exercise disposable real children without PID/group cleanup fallbacks.
- Preserve removable image-bearing skill prompts and atomically remove their hidden vision companions across queued preprocessing.
- Resume sessions through symlink aliases of the current project without treating them as cross-project cwd changes; explicit adoption is still required for a different project.
- Preserve task parent-session ownership before concurrency waits in the upstream speculative-launch path.
- Fura fork: RPC `get_state` reports the session's runtime `cwd` (also in the generated wire schema and Python/Rust/Go clients), so a host can see that a resumed session whose recorded directory is missing continues in the launch directory.
- Fura fork: the `WatchedFilesForwarder` tests give each test room for the 15 s event waits they already budget (Bun's 5 s default timed them out whenever fseventsd lagged under file-system load), and their watcher-readiness sentinel is recreated on every attempt, so a create/delete-only watcher still sees it after macOS missed its first creation. The forwarder itself is unchanged: it already reports a macOS `rename` for a rewritten, recently created file as `Changed`.

## agent

- Added authoritative pending-message identities and atomic removal before claim, preserving sibling preprocessing, internal companions and nonremovable provider-owned input across abort requeue.

## ai

- User messages support optional `clientMessageId` metadata for persistent client submission correlation without changing provider prompt text.

## natives

- Added `Process.identity()` for comparing pinned operating-system process instances across daemon recovery.
- Process-tree termination now protects Unix host ancestors and their groups, and revalidates pinned group ownership before escalation.

## utils

- Subprocess cleanup retains the original native process handle instead of reopening its PID. Unix timeouts refuse an unproven process-group signal after the root exits, report the remaining pipe-holding resources, and still finish output collection at the deadline.

## pi-shell

- Fura fork: `sys::tty::open_pty` (the pty test harness, `zpty`) no longer uses `openpty` and `ttyname_r`, which on macOS fail while other threads open ptys (`Unknown error: -6`, XNU's `EREDRIVEOPEN` from `/dev/ptmx`; `ERANGE`) and made the descriptors close-on-exec only after concurrently spawned children could inherit them. It opens both sides close-on-exec with `posix_openpt` (redriven on `EREDRIVEOPEN`) and names the slave with `ptsname_r`.
- Fura fork: like zsh, ZLE redraws after a `zle -F` handler or a `sched` event only when it gave the display up (`zle -I`, `sched -o`) or the handler left a message (`zle -M`) or bell to show, so a handler no longer wipes a menu selection's status line.
- Fura fork: `zle_hist_pty` and `zsh_comp_pty` wait after each step for the line editor to answer `zle -F` sync requests (`Pty::zle_sync`, which now also waits out what the editor does once a handler returns) instead of a quiet-output window, so slow, silent completion functions no longer get their screen read early; `PI_COMP_QUIET_MS` is gone. `zle_hist_pty` also types no further keys while a line it entered runs (they would meet the terminal in its normal modes: echoed, `^R` taken as reprint). `zle_pty` runs its shells in `/tmp` (the prompt no longer shows the checkout path) and types its first keys only once the line editor has taken the terminal (`Pty::wait_raw`), not after a quiet spell at startup.
