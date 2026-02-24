# muxclaw

AI assistant multiplexer that connects messaging channels to coding agents via `nq` job queue.

## Build & Test

- **Run CLI:** `deno task cli`
- **Lint:** `deno lint`
- **Format:** `deno fmt`
- **Type check:** `deno check`
- **Runtime:** Deno (TypeScript, no build step required).

## Project Overview

- **Architecture:** Three-process model: `ingress` (queueing), `dispatch` (agent execution), and `egress` (response delivery).
- **Job Queue:** Uses `nq`. `ingress` enqueues jobs; `egress` monitors `queue/completed/` and `failed/` using `Deno.watchFs`.
- **Storage:** Follows XDG. Prompts and outputs are stored in `~/.local/share/muxclaw/messages/<channel>/<chatId>_<messageId>/`.
- **Job Mapping:** A temporary symlink `~/.local/share/muxclaw/,HEXTIME.PID.d` connects the `nq` job to its message directory.
- **Agents:** Configurable via `~/.config/muxclaw/config.json`. Default agent is `claude -p`.

## Code Style & Conventions

- **Deno-First:** Use `Deno.*` APIs and `Deno.Command`. Avoid Node.js built-ins.
- **Functional:** Use top-level functions and interfaces. No classes.
- **Error Handling:** `try/catch` with silent fallbacks for optional files. `Deno.exit(1)` for fatal errors.
- **Job Ordering:** `nq` jobs must be processed in lexicographical order of their filenames (`,HEXTIME.PID`) for chronological consistency.
- **Quality:** Run `deno fmt`, `deno lint`, and `deno check` before every commit.
