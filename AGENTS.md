# muxclaw

AI assistant multiplexer that connects messaging channels to coding agents via
`nq` job queue.

## Build & Test

- **Run CLI:** `deno task cli`
- **Lint:** `deno lint`
- **Format:** `deno fmt`
- **Type check:** `deno check --allow-import`
- **Test:** `deno test -P --allow-import`
- **Runtime:** Deno (TypeScript, no build step required).

## Project Overview

- **Architecture:** Three-process model: `ingress` (queueing), `dispatch` (agent
  execution), and `egress` (response delivery).
- **Job Queue:** Uses `nq`. `ingress` enqueues jobs; `egress` monitors
  `queue/completed/` and `failed/` using `Deno.watchFs`.
- **Storage:** Follows XDG. Prompts and outputs are stored in
  `~/.local/share/muxclaw/messages/<channel>/<chatId>_<messageId>/`.
- **Job Mapping:** A temporary symlink `~/.local/share/muxclaw/,HEXTIME.PID.d`
  connects the `nq` job to its message directory.
- **Agents:** Supported agents are `pi` and `claude`, configurable via
  `~/.config/muxclaw/config.json`. Default agent is `pi`. Real-time response
  streaming is supported for both. For `claude`, `muxclaw` automatically passes
  `--add-dir` to allow access to the message attachments directory.

## Code Style & Conventions

- **Deno-First:** Use `Deno.*` APIs and `Deno.Command`. Avoid Node.js built-ins.
- **Functional:** Use top-level functions and interfaces. No classes.
- **Error Handling:** `try/catch` with silent fallbacks for optional files.
  `Deno.exit(1)` for fatal errors.
- **Job Ordering:** `nq` jobs must be processed in lexicographical order of
  their filenames (`,HEXTIME.PID`) for chronological consistency.
- **Quality:** Run lint, type check, format and test before every commit.
- **Commits:** Do NOT use conventional commits (e.g., `feat:`, `fix:`, `docs:`).
  Use a simple, descriptive message instead.

## External API Documentation

When working on features related to Telegram integration or using the grammY
library, agents should consult the following documentation:

- **grammY:** Browse the [grammY API Reference](https://grammy.dev/ref/) to
  understand the bot framework API.
- **Telegram Bot API:** Refer to the official
  [Telegram Bot API documentation](https://core.telegram.org/bots/api) for
  detailed information on available methods, objects, and types.
