# muxclaw

A versatile AI assistant with a simple, elegant architecture — multiplexes
messaging channels to coding agents via
[`nq`](https://github.com/leahneukirchen/nq), a zero-setup Unix job queue.

Three independent processes cooperate via the filesystem:

```
muxclaw ingress                 muxclaw egress
┌──────────────┐               ┌───────────────┐
│ channel →    │               │   → channel   │
│ save message │    nq queue   │ watch for     │
│ + attachments│──────────→────│ completed     │
│ enqueue job  │               │ jobs, reply   │
└──────────────┘               └───────────────┘
                    ↕
            nq → muxclaw dispatch
            (reads prompt.txt,
             runs coding agent)
```

- **ingress** — Long-running channel listener. Saves `prompt.txt`, `meta.json`,
  and attachments into the message directory, then enqueues a `dispatch` job via
  `nq`. A temporary symlink maps the nq job name (`,HEXTIME.PID`) back to the
  message directory.
- **dispatch** — Invoked by `nq`. Reads `prompt.txt` and runs the configured
  coding agent (e.g., `claude -p`). `nq` captures stdout and moves the job file
  to `completed/` or `failed/`.
- **egress** — Long-running watcher. Scans existing jobs on startup, then uses
  `Deno.watchFs` for live events. Reads `meta.json`, sends the agent output back
  to the channel, and moves the job file into the message directory (marking it
  processed).

## Prerequisites

- [Deno](https://deno.land/) (v2+)
- [nq](https://github.com/leahneukirchen/nq) — zero-setup Unix job queue
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- A [Telegram Bot Token](https://core.telegram.org/bots#how-do-i-create-a-bot)

## Setup

Create `~/.config/muxclaw/config.json` with your bot token and allowed users:

```json
{
	"channels": {
		"telegram": {
			"token": "bot123:ABC..."
		}
	},
	"allowedUsers": [
		{ "userId": "12345" }
	],
	"workspace": "/path/to/your/project",
	"agent": {
		"name": "claude"
	}
}
```

You can find your Telegram user ID by messaging
[@userinfobot](https://t.me/userinfobot).

## Usage

Run both commands in separate terminals. The agent runs in the current working
directory unless `workspace` is set in `config.json`:

```sh
# Terminal 1 — receive Telegram messages and queue jobs
deno task cli ingress

# Terminal 2 — watch for completed jobs and send replies
deno task cli egress
```

In private chats the bot handles all messages. In group chats it only responds
to messages that @mention the bot.

Supported message types: text, photos, documents, audio, and voice messages.
Replied-to messages are included as quoted context in the prompt.

## Configuration

Config and state follow the
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

| Directory                       | Purpose                | XDG Variable       |
| ------------------------------- | ---------------------- | ------------------ |
| `~/.config/muxclaw/`            | Config (`config.json`) | `$XDG_CONFIG_HOME` |
| `~/.local/share/muxclaw/`       | Persistent job data    | `$XDG_DATA_HOME`   |
| `~/.local/state/muxclaw/queue/` | nq job queue           | `$XDG_STATE_HOME`  |

```
~/.local/share/muxclaw/
├── messages/
│   └── <channel>/             # e.g., telegram/
│       └── <id>/              # e.g., 123456789_456/
│           ├── prompt.txt     # full prompt (quote + attachments + text)
│           ├── meta.json      # routing info (channel, chatId, messageId, userId)
│           ├── attachments/   # downloaded photos, documents, audio, voice
│           └── ,HEXTIME.PID   # job output (moved here after egress)
└── ,HEXTIME.PID.d             # temporary symlink → message dir (removed after egress)
```

| Variable | Description        | Default                         |
| -------- | ------------------ | ------------------------------- |
| `NQDIR`  | nq queue directory | `$XDG_STATE_HOME/muxclaw/queue` |

## Design Goals

Channels (e.g., Telegram) and coding agents (e.g., Claude Code) should be
configurable and swappable. The architecture intentionally decouples ingress,
dispatch, and egress so that adding a new channel or agent doesn't require
changes to the other components.

## Docker

Pull the image and run the container (mount `claude` CLI, its auth, your config,
and workspace):

```sh
docker run -it --rm \
  -v $(which claude):/usr/local/bin/claude \
  -v ~/.claude:/home/deno/.claude \
  -v ~/.config/muxclaw:/home/deno/.config/muxclaw \
  -v /path/to/your/project:/workspace \
  ghcr.io/jihchi/muxclaw
```

This starts a Zellij session with three panes:

```
┌──────────────┬──────────────┐
│   Ingress    │   Egress     │
├──────────────┴──────────────┤
│     Workspace (/workspace)  │
└─────────────────────────────┘
```

## License

Licensed under either of

- [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)
- [MIT license](http://opensource.org/licenses/MIT)

at your option.
