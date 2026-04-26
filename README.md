# muxclaw

Multiplexes messaging channels to AI agents through a single CLI and a
[file-based job queue](https://github.com/leahneukirchen/nq). Nothing else
required.

![Screencast](./assets/screencast.gif)

```
ingress                         egress
┌──────────────┐               ┌───────────────┐
│ channel →    │               │   → channel   │
│ save message │    nq queue   │ watch for     │
│ + attachments│──────────→────│ completed     │
│ enqueue job  │               │ jobs, reply   │
└──────────────┘               └───────────────┘
                    ↕
            nq → dispatch
            (reads prompt.txt,
             runs coding agent)
```

## Quick Start

Requires [Deno](https://deno.land/) (v2+),
[nq](https://github.com/leahneukirchen/nq), and a coding agent
([Pi](https://pi.dev/)).

[Create a Telegram bot](https://core.telegram.org/bots/features#creating-a-new-bot)
and grab the bot token, then create `~/.config/muxclaw/config.json`:

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
		"name": "pi",
		"stream": true
	}
}
```

Then, in two terminals:

```sh
deno task cli ingress   # receive messages, enqueue jobs
deno task cli egress    # watch for results, send replies
```

## Docker

```sh
docker run -it --rm \
  -v ~/.config/muxclaw:/home/deno/.config/muxclaw \
  -v $(pwd)/workspace:/workspace \
  ghcr.io/jihchi/muxclaw
```

## License

Licensed under either of

- [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)
- [MIT license](http://opensource.org/licenses/MIT)

at your option.
