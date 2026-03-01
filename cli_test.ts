import { assertEquals, assertRejects } from '@std/assert';
import {
	assertSpyCall,
	assertSpyCalls,
	type Stub,
	stub,
} from '@std/testing/mock';
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { join } from '@std/path';

import {
	type Config,
	createIngressHandler,
	dispatch,
	type IngressContext,
	processJob,
	type TelegramBot,
	validateWorkspace,
} from './cli.ts';

const APP_NAME = 'muxclaw';
const USER_HOME = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '/tmp';

const CONFIG_DIR = join(
	Deno.env.get('XDG_CONFIG_HOME') ?? join(USER_HOME, '.config'),
	APP_NAME,
);

const DATA_DIR = join(
	Deno.env.get('XDG_DATA_HOME') ?? join(USER_HOME, '.local', 'share'),
	APP_NAME,
);

const STATE_DIR = join(
	Deno.env.get('XDG_STATE_HOME') ?? join(USER_HOME, '.local', 'state'),
	APP_NAME,
);

const QUEUE_DIR = Deno.env.get('NQDIR') ?? join(STATE_DIR, 'queue');
const QUEUE_COMPLETED_DIR = join(QUEUE_DIR, 'completed');
const QUEUE_FAILED_DIR = join(QUEUE_DIR, 'failed');

function fakeCommand(
	overrides?: Partial<Deno.CommandOutput>,
): Deno.Command {
	return {
		output: () =>
			Promise.resolve({
				success: true,
				code: 0,
				signal: null,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				...overrides,
			}),
		outputSync: (): never => {
			throw new Error('not implemented');
		},
		spawn: (): never => {
			throw new Error('not implemented');
		},
	};
}

function fakeContext(
	opts: {
		from?: { id: number; username?: string };
		chat?: { id: number };
		message?: { message_id: number; text?: string };
	},
): IngressContext {
	return {
		...opts,
		replyWithChatAction: () => Promise.resolve(true),
	};
}

function stubDenoExit() {
	return stub(Deno, 'exit', () => {
		throw new Error('exit');
	});
}

function createBot(): TelegramBot {
	return {
		token: 'mock-token',
		api: {
			getFile: () => Promise.resolve({ file_path: 'mock/path' }),
			sendChatAction: () => Promise.resolve(true),
			sendMessage: () => Promise.resolve({}),
		},
	};
}

it('displays help', async () => {
	const { code, stdout } = await new Deno.Command(Deno.execPath(), {
		args: ['task', 'cli'],
		stdout: 'piped',
	}).output();

	assertEquals(code, 0);
	assertEquals(
		new TextDecoder().decode(stdout),
		`${APP_NAME} — channel-to-coding-agent bridge

Usage:
  ${APP_NAME}                     Show this help
  ${APP_NAME} help                Show this help
  ${APP_NAME} ingress             Start ingress (channel → queue)
  ${APP_NAME} egress              Start egress reactor (queue → channel, watches continuously)
  ${APP_NAME} dispatch <message>   Dispatch message to configured agent
  ${APP_NAME} dispatch --stdin     Read message from stdin
  ${APP_NAME} dispatch --id <chan>:<id> Read message from natural key store
`,
	);
});

describe('validateWorkspace', () => {
	it('passes for existing directory', async () => {
		const config: Config = {
			channels: { telegram: { token: 'mock' } },
			allowedUsers: [],
			workspace: Deno.cwd(),
			agent: { name: 'claude' },
		};
		await validateWorkspace(config);
	});

	it('fails for non-existent directory', async () => {
		const config: Config = {
			channels: { telegram: { token: 'mock' } },
			allowedUsers: [],
			workspace: '/non/existent/path',
			agent: { name: 'claude' },
		};
		using exitStub = stubDenoExit();
		using errorStub = stub(console, 'error');

		await assertRejects(
			() => validateWorkspace(config),
			Error,
			'exit',
		);

		assertSpyCall(errorStub, 0, {
			args: [`Error: Workspace directory does not exist: /non/existent/path`],
		});

		assertSpyCalls(exitStub, 1);
	});

	it('fails for a file path', async () => {
		await using tempFile = await (async () => {
			const path = await Deno.makeTempFile();
			return {
				path,
				[Symbol.asyncDispose]: () => Deno.remove(path),
			};
		})();

		const config: Config = {
			channels: { telegram: { token: 'mock' } },
			allowedUsers: [],
			workspace: tempFile.path,
			agent: { name: 'claude' },
		};
		using exitStub = stubDenoExit();
		using errorStub = stub(console, 'error');

		await assertRejects(
			() => validateWorkspace(config),
			Error,
			'exit',
		);

		assertSpyCall(errorStub, 0, {
			args: [
				`Error: Workspace path is a file, not a directory: ${tempFile.path}`,
			],
		});

		assertSpyCalls(exitStub, 2);
	});
});

describe('dispatch', () => {
	it('calls claude with joined args', async () => {
		using readStub = stub(
			Deno,
			'readTextFile',
			() =>
				Promise.resolve(
					JSON.stringify({
						channels: { telegram: { token: 'mock-token' } },
						allowedUsers: [],
					}),
				),
		);
		using cmdStub = stub(Deno, 'Command', () => fakeCommand());
		using exitStub = stubDenoExit();

		await dispatch(['hello', 'world']);

		assertSpyCall(readStub, 0, { args: [join(CONFIG_DIR, 'config.json')] });

		assertSpyCall(cmdStub, 0, {
			args: ['claude', {
				args: ['-p', 'hello world'],
				cwd: Deno.cwd(),
				stdin: 'null',
				stdout: 'inherit',
				stderr: 'inherit',
			}],
		});

		assertSpyCalls(exitStub, 0);
	});

	it('reads prompt from file with --id', async () => {
		using readStub = stub(
			Deno,
			'readTextFile',
			(path) => {
				const p = path.toString();
				if (p.includes('config.json')) {
					return Promise.resolve(
						JSON.stringify({
							channels: { telegram: { token: 'mock-token' } },
							allowedUsers: [],
						}),
					);
				}
				if (p.includes('prompt.txt')) {
					return Promise.resolve('mocked prompt');
				}
				return Promise.resolve('');
			},
		);
		using cmdStub = stub(Deno, 'Command', () => fakeCommand());
		using exitStub = stubDenoExit();

		await dispatch(['--id', 'telegram:1_1']);

		assertSpyCall(readStub, 0, { args: [join(CONFIG_DIR, 'config.json')] });

		assertSpyCall(readStub, 1, {
			args: [join(DATA_DIR, 'messages', 'telegram', '1_1', 'prompt.txt')],
		});

		assertSpyCall(cmdStub, 0, {
			args: ['claude', {
				args: ['-p', 'mocked prompt'],
				cwd: Deno.cwd(),
				stdin: 'null',
				stdout: 'inherit',
				stderr: 'inherit',
			}],
		});

		assertSpyCalls(exitStub, 0);
	});

	it('shows error if message not found with --id', async () => {
		using readStub = stub(
			Deno,
			'readTextFile',
			(path) => {
				const p = path.toString();
				if (p.includes('config.json')) {
					return Promise.resolve(
						JSON.stringify({
							channels: { telegram: { token: 'mock-token' } },
							allowedUsers: [],
						}),
					);
				}
				return Promise.reject(new Deno.errors.NotFound());
			},
		);
		using errorStub = stub(console, 'error');
		using exitStub = stubDenoExit();

		const fullId = 'telegram:999_999';
		const [channel, id] = fullId.split(':');
		const expectedPath = join(
			DATA_DIR,
			'messages',
			channel,
			id,
			'prompt.txt',
		);

		await assertRejects(
			() => dispatch(['--id', fullId]),
			Error,
			'exit',
		);

		assertSpyCall(readStub, 0, { args: [join(CONFIG_DIR, 'config.json')] });
		assertSpyCall(readStub, 1, { args: [expectedPath] });

		assertSpyCall(errorStub, 0, {
			args: [`Error: message not found: ${expectedPath}`],
		});

		assertSpyCalls(exitStub, 1);
	});

	it('shows error if config file is not found', async () => {
		using readStub = stub(
			Deno,
			'readTextFile',
			() => Promise.reject(new Deno.errors.NotFound()),
		);
		using errorStub = stub(console, 'error');
		using exitStub = stubDenoExit();

		await assertRejects(
			() => dispatch([]),
			Error,
			'exit',
		);

		assertSpyCalls(readStub, 1);

		assertSpyCall(errorStub, 0, {
			args: [
				`Error: Failed to load or parse ${join(CONFIG_DIR, 'config.json')}:`,
				'',
			],
		});

		assertSpyCalls(exitStub, 1);
	});

	it('shows error if failed to parse json', async () => {
		using readStub = stub(
			Deno,
			'readTextFile',
			() => Promise.resolve('invalid json'),
		);
		using errorStub = stub(console, 'error');
		using exitStub = stubDenoExit();

		await assertRejects(
			() => dispatch([]),
			Error,
			'exit',
		);

		assertSpyCalls(readStub, 1);

		assertSpyCall(errorStub, 0, {
			args: [
				`Error: Failed to load or parse ${join(CONFIG_DIR, 'config.json')}:`,
				'Unexpected token \'i\', "invalid json" is not valid JSON',
			],
		});

		assertSpyCalls(exitStub, 1);
	});
});

describe('processJob', () => {
	let logStub: Stub;

	beforeEach(() => {
		logStub = stub(console, 'log');
	});

	afterEach(() => {
		logStub.restore();
	});

	it('sends output as reply', async () => {
		const bot = createBot();

		using actionSpy = stub(
			bot.api,
			'sendChatAction',
			() => Promise.resolve(true),
		);
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));
		using readStub = stub(
			Deno,
			'readTextFile',
			(path) =>
				path.toString().includes('meta.json')
					? Promise.resolve(
						JSON.stringify({
							channel: 'telegram',
							chatId: 123,
							messageId: 456,
						}),
					)
					: Promise.resolve(
						// https://core.telegram.org/bots/api#markdownv2-style
						`
*bold \\*text*
_italic \\*text_
__underline__
~strikethrough~
||spoiler||
*bold _italic bold ~italic bold strikethrough ||italic bold strikethrough spoiler||~ __underline italic bold___ bold*
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user?id=123456789)
![👍](tg://emoji?id=5368324170671202286)
![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)
![22:45 tomorrow](tg://time?unix=1647531900&format=t)
![22:45 tomorrow](tg://time?unix=1647531900&format=r)
![22:45 tomorrow](tg://time?unix=1647531900)
\`inline fixed-width code\`
\`\`\`
pre-formatted fixed-width code block
\`\`\`
\`\`\`python
pre-formatted fixed-width code block written in the Python programming language
\`\`\`
HTML tags should be escaped: <del>Deleted text</del>
>Block quotation started
>Block quotation continued
>Block quotation continued
>Block quotation continued
>The last line of the block quotation
**>The expandable block quotation started right after the previous block quotation
>It is separated from the previous block quotation by an empty bold entity
>Expandable block quotation continued
>Hidden by default part of the expandable block quotation started
>Expandable block quotation continued
>The last line of the expandable block quotation with the expandability mark||`,
					),
		);
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());

		await processJob('/mock/dir', ',job', bot);

		assertSpyCall(actionSpy, 0, {
			args: [123, 'typing'],
		});

		assertSpyCall(readStub, 0, {
			args: [join(DATA_DIR, ',job.d', 'meta.json')],
		});

		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				`_italic \\*text_
*underline*
~strikethrough~
\\|\\|spoiler\\|\\|
_bold _italic bold ~italic bold strikethrough \\|\\|italic bold strikethrough spoiler\\|\\|~ *underline italic bold*_ bold_
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user\\?id\\=123456789)
[👍](tg://emoji\\?id\\=5368324170671202286)
[22:45 tomorrow](tg://time\\?unix\\=1647531900&format\\=wDT)
[22:45 tomorrow](tg://time\\?unix\\=1647531900&format\\=t)
[22:45 tomorrow](tg://time\\?unix\\=1647531900&format\\=r)
[22:45 tomorrow](tg://time\\?unix\\=1647531900)
\`inline fixed-width code\`

\`\`\`
pre-formatted fixed-width code block
\`\`\`

\`\`\`
pre-formatted fixed-width code block written in the Python programming language
\`\`\`

HTML tags should be escaped: <del\\>Deleted text</del\\>

\\> Block quotation started
\\> Block quotation continued
\\> Block quotation continued
\\> Block quotation continued
\\> The last line of the block quotation
\\> \\\\\\*\\\\\\*\\\\\\>The expandable block quotation started right after the previous block quotation
\\> It is separated from the previous block quotation by an empty bold entity
\\> Expandable block quotation continued
\\> Hidden by default part of the expandable block quotation started
\\> Expandable block quotation continued
`,
				{
					parse_mode: 'MarkdownV2',
					reply_parameters: { message_id: 456 },
				},
			],
		});

		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});
	});

	it('splits long output into multiple messages', async () => {
		const bot = createBot();

		stub(bot.api, 'sendChatAction', () => Promise.resolve(true));
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));

		const longOutput = 'A'.repeat(4000) + '\n' + 'B'.repeat(1000);

		stub(
			Deno,
			'readTextFile',
			(path) =>
				path.toString().includes('meta.json')
					? Promise.resolve(
						JSON.stringify({
							channel: 'telegram',
							chatId: 123,
							messageId: 456,
						}),
					)
					: Promise.resolve(longOutput),
		);
		stub(Deno, 'rename', () => Promise.resolve());
		stub(Deno, 'lstat', () => Promise.reject(new Deno.errors.NotFound()));

		await processJob('/mock/dir', ',job', bot);

		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				'A'.repeat(4000),
				{
					reply_parameters: { message_id: 456 },
					parse_mode: 'MarkdownV2',
				},
			],
		});

		assertSpyCall(msgSpy, 1, {
			args: [
				123,
				'B'.repeat(1000),
				{
					reply_parameters: { message_id: 456 },
					parse_mode: 'MarkdownV2',
				},
			],
		});

		assertSpyCalls(msgSpy, 2);
	});
});

describe('ingress handler', () => {
	let logStub: Stub;

	beforeEach(() => {
		logStub = stub(console, 'log');
	});

	afterEach(() => {
		logStub.restore();
	});

	it('queues valid message', async () => {
		const bot = createBot();
		const handler = createIngressHandler(bot, new Set(['123']));
		const ctx = fakeContext({
			from: { id: 123, username: 'user' },
			chat: { id: 456 },
			message: { message_id: 789, text: 'hello' },
		});

		using mkdirStub = stub(Deno, 'mkdir', () => Promise.resolve());
		using writeStub = stub(Deno, 'writeTextFile', () => Promise.resolve());
		using symlinkStub = stub(Deno, 'symlink', () => Promise.resolve());
		using cmdStub = stub(Deno, 'Command', () =>
			fakeCommand({
				stdout: new TextEncoder().encode(',job'),
			}));

		await handler(ctx);

		const msgDir = join(DATA_DIR, 'messages', 'telegram', '456_789');

		assertSpyCall(mkdirStub, 0, {
			args: [msgDir, { recursive: true, mode: 0o755 }],
		});

		assertSpyCall(writeStub, 0, {
			args: [join(msgDir, 'prompt.txt'), 'hello'],
		});

		assertSpyCall(cmdStub, 0, {
			args: ['nq', {
				args: [
					Deno.execPath(),
					'task',
					'--quiet',
					'cli',
					'dispatch',
					'--id',
					'telegram:456_789',
				],
				cwd: import.meta.dirname,
				env: {
					NQDIR: QUEUE_DIR,
					NQDONEDIR: QUEUE_COMPLETED_DIR,
					NQFAILDIR: QUEUE_FAILED_DIR,
				},
				stdin: 'null',
				stdout: 'piped',
				stderr: 'piped',
			}],
		});

		assertSpyCall(symlinkStub, 0, { args: [msgDir, join(DATA_DIR, ',job.d')] });
	});
});
