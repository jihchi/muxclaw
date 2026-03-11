import {
	assertEquals,
	assertGreaterOrEqual,
	assertRejects,
	assertStrictEquals,
} from '@std/assert';
import {
	assertSpyCall,
	assertSpyCalls,
	type Stub,
	stub,
} from '@std/testing/mock';
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { join } from '@std/path';
import { Api } from 'grammy';
import * as v from '@valibot/valibot';

import {
	type Config,
	createIngressHandler,
	dispatch,
	getAgentParser,
	type IngressContext,
	isGroupChat,
	type Parser,
	processJob,
	processStreamOutput,
	StreamEvent,
	type StreamSender,
	type TelegramBot,
	truncateDraft,
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
	spawnOverrides?: Partial<Deno.ChildProcess>,
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
		spawn: () => ({
			status: Promise.resolve({ success: true, code: 0, signal: null }),
			output: () =>
				Promise.resolve({
					success: true,
					code: 0,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
				}),
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
			stdin: new WritableStream(),
			kill: () => {},
			ref: () => {},
			unref: () => {},
			[Symbol.dispose]: () => {},
			...spawnOverrides,
		} as unknown as Deno.ChildProcess),
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

function stubFiles(mocks: Record<string, string | object>): Stub {
	return stub(Deno, 'readTextFile', (path) => {
		const p = path.toString();
		for (const [key, value] of Object.entries(mocks)) {
			if (p.includes(key)) {
				return Promise.resolve(
					typeof value === 'string' ? value : JSON.stringify(value),
				);
			}
		}
		return Promise.reject(new Deno.errors.NotFound());
	});
}

function createBot(): TelegramBot {
	return {
		token: 'mock-token',
		api: {
			editMessageText: () => Promise.resolve({}),
			getFile: () => Promise.resolve({ file_path: 'mock/path' }),
			sendChatAction: () => Promise.resolve(true),
			sendMessage: () => Promise.resolve({}),
			sendMessageDraft: () => Promise.resolve(true),
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

describe('getAgentParser', () => {
	it('parses Claude delta', () => {
		const parser = getAgentParser('claude');
		const json = {
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'hello' },
			},
		};
		assertEquals(parser(json), { type: 'delta', text: 'hello' });
	});

	it('parses Claude final', () => {
		const parser = getAgentParser('claude');
		const json = {
			type: 'result',
			subtype: 'success',
			result: 'final',
		};
		assertEquals(parser(json), { type: 'final', text: 'final' });
	});

	it('parses Pi delta', () => {
		const parser = getAgentParser('pi');
		const json = {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'world' },
		};
		assertEquals(parser(json), { type: 'delta', text: 'world' });
	});

	it('parses Pi final', () => {
		const parser = getAgentParser('pi');
		const json = {
			type: 'message_end',
			message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
		};
		assertEquals(parser(json), { type: 'final', text: 'done' });
	});
});

describe('truncateDraft', () => {
	it('handles text within limit', () => {
		const text = 'short text';
		assertStrictEquals(truncateDraft(text), 'short text');
	});

	it('truncates long text at newline', () => {
		const text = 'a'.repeat(2000) + '\n' + 'b'.repeat(2100); // 4101 chars total
		const result = truncateDraft(text);
		assertStrictEquals(result, '...\n' + 'b'.repeat(2100));
	});

	it('falls back when no newline exists', () => {
		const text = 'a'.repeat(5000);
		const result = truncateDraft(text);
		assertStrictEquals(result, '...' + 'a'.repeat(4093)); // 4096 total
	});
});

describe('processStreamOutput', () => {
	it('handles final flush (hasUnsentDraft)', async () => {
		const encoder = new TextEncoder();
		const stdout = new ReadableStream({
			start(controller) {
				// Delta 1: Will trigger immediately because lastSentAt = 0
				controller.enqueue(
					encoder.encode(
						JSON.stringify({ type: 'delta', text: 'hello' }) + '\n',
					),
				);
				// Delta 2: Won't trigger sync because < 500 chars and < 500ms elapsed since Delta 1
				controller.enqueue(
					encoder.encode(
						JSON.stringify({ type: 'delta', text: ' world' }) + '\n',
					),
				);
				controller.close();
			},
		});

		const calls: string[] = [];
		const sender: StreamSender = {
			throttleMs: 500,
			update: (text: string) => {
				calls.push(text);
				return Promise.resolve();
			},
		};

		const parser: Parser = (json: unknown) => v.parse(StreamEvent, json);

		const final = await processStreamOutput({ stdout, sender, parser });

		assertEquals(final, 'hello world');
		assertEquals(calls, ['hello', 'hello world']);
	});
});

describe('validateWorkspace', () => {
	it('passes for existing directory', async () => {
		const config: Config = {
			channels: { telegram: { token: 'mock' } },
			allowedUsers: [],
			workspace: Deno.cwd(),
			agent: { name: 'pi', stream: false },
		};
		await validateWorkspace(config);
	});

	it('fails for non-existent directory', async () => {
		const config: Config = {
			channels: { telegram: { token: 'mock' } },
			allowedUsers: [],
			workspace: '/non/existent/path',
			agent: { name: 'pi', stream: false },
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
			agent: { name: 'pi', stream: false },
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
	it('calls pi with joined args', async () => {
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
			},
		});
		using cmdStub = stub(Deno, 'Command', () => fakeCommand());
		using exitStub = stubDenoExit();

		await dispatch(['hello', 'world']);

		assertSpyCall(cmdStub, 0, {
			args: ['pi', {
				args: ['-p'],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'inherit',
				stderr: 'inherit',
			}],
		});

		assertSpyCalls(exitStub, 0);
	});

	it('uses inherited stdout when dispatching without --id', async () => {
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'claude', stream: true },
			},
		});

		using cmdStub = stub(
			Deno,
			'Command',
			() => fakeCommand(),
		);
		using exitStub = stubDenoExit();

		await dispatch(['whats', 'up']);

		assertSpyCall(cmdStub, 0, {
			args: ['claude', {
				args: [
					'--add-dir',
					DATA_DIR,
					'-p',
				],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'inherit',
				stderr: 'inherit',
			}],
		});

		assertSpyCalls(exitStub, 0);
	});

	it('reads prompt from file with --id', async () => {
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'prompt.txt': 'mocked prompt',
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
		});

		using draftSpy = stub(
			Api.prototype,
			'sendMessageDraft',
			() => Promise.resolve(true),
		);

		const emptyStream = new ReadableStream({
			start(controller) {
				controller.close();
			},
		});

		using cmdStub = stub(
			Deno,
			'Command',
			() =>
				fakeCommand({}, {
					stdout: emptyStream as unknown as Deno.SubprocessReadableStream,
				}),
		);
		using logStub = stub(console, 'log');

		const now = Date.now();

		await dispatch(['--id', 'telegram:1_1']);

		assertSpyCalls(logStub, 1);

		assertEquals(draftSpy.calls[0].args[0], 123);
		assertGreaterOrEqual(draftSpy.calls[0].args[1], now);
		assertEquals(draftSpy.calls[0].args[2], '(💬 processing...)');

		assertSpyCall(cmdStub, 0, {
			args: ['pi', {
				args: [
					'--mode',
					'json',
					'-p',
				],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'piped',
				stderr: 'inherit',
			}],
		});
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

	it('streams output for Claude', async () => {
		const fullId = 'telegram:1_1';

		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'claude', stream: true },
			},
			'prompt.txt': 'mocked prompt',
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
		});

		const events = [
			{
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: 'A'.repeat(250) },
				},
			},
			{
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: 'B'.repeat(250) },
				},
			},
			{
				type: 'result',
				subtype: 'success',
				result: 'A'.repeat(250) + 'B'.repeat(250),
			},
		].map((e) => JSON.stringify(e)).map((json) => `${json}\n`);

		const encoder = new TextEncoder();
		const stdoutStream = new ReadableStream({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(event));
				}
				controller.close();
			},
		});

		using draftSpy = stub(
			Api.prototype,
			'sendMessageDraft',
			() => Promise.resolve(true),
		);

		using cmdStub = stub(
			Deno,
			'Command',
			() =>
				fakeCommand({}, {
					stdout: stdoutStream as unknown as Deno.SubprocessReadableStream,
				}),
		);
		using logStub = stub(console, 'log');

		await dispatch(['--id', fullId]);

		assertSpyCall(cmdStub, 0, {
			args: ['claude', {
				args: [
					'--add-dir',
					DATA_DIR,
					'--output-format',
					'stream-json',
					'--verbose',
					'--include-partial-messages',
					'-p',
				],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'piped',
				stderr: 'inherit',
			}],
		});

		// 1 initial draft "...💬" + 2 drafts during streaming (total 3)
		assertSpyCalls(draftSpy, 3);

		const draftChatIds = draftSpy.calls.map((c) => c.args[0]);
		assertEquals(draftChatIds, [123, 123, 123]);

		const draftTexts = draftSpy.calls.map((c) => c.args[2]);
		assertEquals(draftTexts, [
			'(💬 processing...)',
			'A'.repeat(250),
			'A'.repeat(250) + 'B'.repeat(250),
		]);

		assertSpyCall(logStub, 0, { args: ['A'.repeat(250) + 'B'.repeat(250)] });
	});

	it('streams output for Pi', async () => {
		const fullId = 'telegram:1_1';

		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'prompt.txt': 'mocked prompt',
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
		});

		const events = [
			{
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: 'A'.repeat(250),
				},
			},
			{
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: 'B'.repeat(250),
				},
			},
			{
				type: 'message_end',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'A'.repeat(250) + 'B'.repeat(250) },
					],
				},
			},
		].map((e) => JSON.stringify(e)).map((json) => `${json}\n`);

		const encoder = new TextEncoder();
		const stdoutStream = new ReadableStream({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(event));
				}
				controller.close();
			},
		});

		using draftSpy = stub(
			Api.prototype,
			'sendMessageDraft',
			() => Promise.resolve(true),
		);

		using cmdStub = stub(
			Deno,
			'Command',
			() =>
				fakeCommand({}, {
					stdout: stdoutStream as unknown as Deno.SubprocessReadableStream,
				}),
		);
		using logStub = stub(console, 'log');

		await dispatch(['--id', fullId]);

		assertSpyCall(cmdStub, 0, {
			args: ['pi', {
				args: [
					'--mode',
					'json',
					'-p',
				],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'piped',
				stderr: 'inherit',
			}],
		});

		// 1 initial draft "...💬" + 2 drafts during streaming (total 3)
		assertSpyCalls(draftSpy, 3);

		const draftTexts = draftSpy.calls.map((c) => c.args[2]);
		assertEquals(draftTexts, [
			'(💬 processing...)',
			'A'.repeat(250),
			'A'.repeat(250) + 'B'.repeat(250),
		]);

		assertSpyCall(logStub, 0, { args: ['A'.repeat(250) + 'B'.repeat(250)] });
	});

	it('streams output for group chat via editMessageText', async () => {
		const fullId = 'telegram:1_1';

		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'prompt.txt': 'mocked prompt',
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
				chatType: 'group',
			},
		});

		const events = [
			{
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: 'A'.repeat(250),
				},
			},
			{
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: 'B'.repeat(250),
				},
			},
			{
				type: 'message_end',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'A'.repeat(250) + 'B'.repeat(250) },
					],
				},
			},
		].map((e) => JSON.stringify(e)).map((json) => `${json}\n`);

		const encoder = new TextEncoder();
		const stdoutStream = new ReadableStream({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(event));
				}
				controller.close();
			},
		});

		// Seed message via sendMessage
		using msgSpy = stub(
			Api.prototype,
			// deno-lint-ignore no-explicit-any
			'sendMessage' as any,
			() => Promise.resolve({ message_id: 999 }),
		);

		using editSpy = stub(
			Api.prototype,
			// deno-lint-ignore no-explicit-any
			'editMessageText' as any,
			() => Promise.resolve({}),
		);

		using cmdStub = stub(
			Deno,
			'Command',
			() =>
				fakeCommand({}, {
					stdout: stdoutStream as unknown as Deno.SubprocessReadableStream,
				}),
		);
		using logStub = stub(console, 'log');

		await dispatch(['--id', fullId]);

		assertSpyCalls(cmdStub, 1);

		// Seed message sent with reply
		assertSpyCalls(msgSpy, 1);
		assertEquals(msgSpy.calls[0].args[0], 123);
		assertEquals(msgSpy.calls[0].args[1], '(💬 processing...)');

		// Stream updates via editMessageText (2 deltas trigger edits)
		assertSpyCalls(editSpy, 2);
		assertEquals(editSpy.calls[0].args[0], 123);
		assertEquals(editSpy.calls[0].args[1], 999);
		assertEquals(editSpy.calls[0].args[2], 'A'.repeat(250));
		assertEquals(editSpy.calls[1].args[2], 'A'.repeat(250) + 'B'.repeat(250));

		assertSpyCall(logStub, 0, { args: ['A'.repeat(250) + 'B'.repeat(250)] });
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
		using _ = stubFiles({
			'config.json': 'invalid json',
		});
		using errorStub = stub(console, 'error');
		using exitStub = stubDenoExit();

		await assertRejects(
			() => dispatch([]),
			Error,
			'exit',
		);

		assertSpyCall(errorStub, 0, {
			args: [
				`Error: Failed to load or parse ${join(CONFIG_DIR, 'config.json')}:`,
				'Unexpected token \'i\', "invalid json" is not valid JSON',
			],
		});

		assertSpyCalls(exitStub, 1);
	});

	it('does NOT stream for Telegram if stream is false', async () => {
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: false },
			},
			'prompt.txt': 'mocked prompt',
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
		});

		using cmdStub = stub(Deno, 'Command', () => fakeCommand());
		using _exitStub = stubDenoExit();

		await dispatch(['--id', 'telegram:1_1']);

		assertSpyCall(cmdStub, 0, {
			args: ['pi', {
				args: ['-p'],
				cwd: Deno.cwd(),
				stdin: 'piped',
				stdout: 'inherit',
				stderr: 'inherit',
			}],
		});
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
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: false },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
			',job': `
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
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());

		await processJob('/mock/dir', ',job', bot);

		assertSpyCall(actionSpy, 0, {
			args: [123, 'typing'],
		});

		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				`_italic \\*text_
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
>Expandable block quotation continued`,
				{
					reply_parameters: {
						message_id: 456,
						allow_sending_without_reply: true,
					},
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

		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: false },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
			},
			',job': longOutput,
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());
		using lstatStub = stub(
			Deno,
			'lstat',
			() => Promise.reject(new Deno.errors.NotFound()),
		);

		await processJob('/mock/dir', ',job', bot);

		assertSpyCall(lstatStub, 0, {
			args: [join(DATA_DIR, ',job.d')],
		});

		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});

		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				'A'.repeat(4000),
				{
					reply_parameters: {
						message_id: 456,
						allow_sending_without_reply: true,
					},
				},
			],
		});

		assertSpyCall(msgSpy, 1, {
			args: [
				123,
				'B'.repeat(1000),
				{
					reply_parameters: {
						message_id: 456,
						allow_sending_without_reply: true,
					},
				},
			],
		});

		assertSpyCalls(msgSpy, 2);
	});

	it('skips sending for streamed group chat', async () => {
		const bot = createBot();

		using actionSpy = stub(
			bot.api,
			'sendChatAction',
			() => Promise.resolve(true),
		);
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
				chatType: 'group',
			},
			',job': 'first line\nsome output\nlast line',
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());
		using lstatStub = stub(
			Deno,
			'lstat',
			() => Promise.reject(new Deno.errors.NotFound()),
		);

		await processJob('/mock/dir', ',job', bot);

		// Should NOT send any message or action
		assertSpyCalls(actionSpy, 0);
		assertSpyCalls(msgSpy, 0);

		// Should still do cleanup (rename)
		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});

		assertSpyCall(lstatStub, 0, {
			args: [join(DATA_DIR, ',job.d')],
		});
	});

	it('skips sending for streamed supergroup chat', async () => {
		const bot = createBot();

		using actionSpy = stub(
			bot.api,
			'sendChatAction',
			() => Promise.resolve(true),
		);
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
				chatType: 'supergroup',
			},
			',job': 'first line\nsome output\nlast line',
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());
		using lstatStub = stub(
			Deno,
			'lstat',
			() => Promise.reject(new Deno.errors.NotFound()),
		);

		await processJob('/mock/dir', ',job', bot);

		assertSpyCalls(actionSpy, 0);
		assertSpyCalls(msgSpy, 0);

		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});

		assertSpyCall(lstatStub, 0, {
			args: [join(DATA_DIR, ',job.d')],
		});
	});

	it('sends normally for group chat when stream is false', async () => {
		const bot = createBot();

		using actionSpy = stub(
			bot.api,
			'sendChatAction',
			() => Promise.resolve(true),
		);
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: false },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
				chatType: 'group',
			},
			',job': 'first line\nsome output\nlast line',
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());

		await processJob('/mock/dir', ',job', bot);

		assertSpyCalls(actionSpy, 1);
		assertSpyCalls(msgSpy, 1);
		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				'some output',
				{
					reply_parameters: {
						message_id: 456,
						allow_sending_without_reply: true,
					},
				},
			],
		});

		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});
	});

	it('sends normally for private chat when stream is true', async () => {
		const bot = createBot();

		using actionSpy = stub(
			bot.api,
			'sendChatAction',
			() => Promise.resolve(true),
		);
		using msgSpy = stub(bot.api, 'sendMessage', () => Promise.resolve({}));
		using _ = stubFiles({
			'config.json': {
				channels: { telegram: { token: 'mock-token' } },
				allowedUsers: [],
				agent: { name: 'pi', stream: true },
			},
			'meta.json': {
				channel: 'telegram',
				chatId: 123,
				messageId: 456,
				chatType: 'private',
			},
			',job': 'first line\nsome output\nlast line',
		});
		using renameStub = stub(Deno, 'rename', () => Promise.resolve());

		await processJob('/mock/dir', ',job', bot);

		assertSpyCalls(actionSpy, 1);
		assertSpyCalls(msgSpy, 1);
		assertSpyCall(msgSpy, 0, {
			args: [
				123,
				'some output',
				{
					reply_parameters: {
						message_id: 456,
						allow_sending_without_reply: true,
					},
				},
			],
		});
		assertSpyCall(renameStub, 0, {
			args: ['/mock/dir/,job', join(DATA_DIR, ',job.d', ',job')],
		});
	});
});

describe('isGroupChat', () => {
	it('returns true for group', () => {
		assertEquals(isGroupChat('group'), true);
	});

	it('returns true for supergroup', () => {
		assertEquals(isGroupChat('supergroup'), true);
	});

	it('returns false for private', () => {
		assertEquals(isGroupChat('private'), false);
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
