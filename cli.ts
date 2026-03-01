import { type Api, Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { basename, dirname, join } from '@std/path';
import * as v from '@valibot/valibot';
import { convert } from 'telegram-markdown-v2';

const AgentName = v.picklist(['claude']);
type AgentName = v.InferOutput<typeof AgentName>;

const Config = v.object({
	channels: v.object({
		telegram: v.object({ token: v.string() }),
	}),
	allowedUsers: v.array(v.object({ userId: v.string() })),
	workspace: v.optional(v.string()),
	agent: v.optional(
		v.object({ name: v.optional(AgentName, 'claude') }),
		{ name: 'claude' },
	),
});
export type Config = v.InferOutput<typeof Config>;

const JobMeta = v.object({
	channel: v.literal('telegram'),
	chatId: v.number(),
	messageId: v.number(),
	userId: v.optional(v.number()),
});
type JobMeta = v.InferOutput<typeof JobMeta>;

export interface TelegramBot extends Pick<Bot, 'token'> {
	api: {
		[K in 'getFile' | 'sendChatAction' | 'sendMessage']: Api[K] extends (
			...args: infer A
		) => Promise<infer R> ? (...args: A) => Promise<Partial<R>>
			: Api[K];
	};
}

export interface IngressContext extends Pick<Context, 'replyWithChatAction'> {
	from?: Partial<Context['from']>;
	chat?: Partial<Context['chat']>;
	message?: Partial<Message>;
}

interface AttachmentInfo {
	fileId: string;
	fileName: string;
}

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

const MESSAGES_DIR = join(DATA_DIR, 'messages');
const APP_CONFIG = join(CONFIG_DIR, 'config.json');

const QUEUE_DIR = Deno.env.get('NQDIR') ?? join(STATE_DIR, 'queue');
const QUEUE_COMPLETED_DIR = join(QUEUE_DIR, 'completed');
const QUEUE_FAILED_DIR = join(QUEUE_DIR, 'failed');

function getMessageDir(channel: string, id: string): string {
	return join(MESSAGES_DIR, channel, id);
}

async function loadConfig(): Promise<Config> {
	try {
		const text = await Deno.readTextFile(APP_CONFIG);
		return v.parse(Config, JSON.parse(text));
	} catch (err) {
		console.error(
			`Error: Failed to load or parse ${APP_CONFIG}:`,
			err instanceof Error ? err.message : err,
		);

		return {
			channels: { telegram: { token: '' } },
			allowedUsers: [],
			agent: { name: 'claude' },
		};
	}
}

function getWorkspaceDir(config: Config): string {
	const ws = config.workspace;
	if (!ws) return Deno.cwd();
	return ws.startsWith('~/') ? join(USER_HOME, ws.slice(2)) : ws;
}

export async function validateWorkspace(config: Config): Promise<void> {
	const ws = getWorkspaceDir(config);
	try {
		const stat = await Deno.stat(ws);
		if (!stat.isDirectory) {
			console.error(`Error: Workspace path is a file, not a directory: ${ws}`);
			Deno.exit(1);
		}
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) {
			console.error(`Error: Workspace directory does not exist: ${ws}`);
		} else {
			console.error(
				`Error: Failed to access workspace ${ws}:`,
				err instanceof Error ? err.message : err,
			);
		}
		Deno.exit(1);
	}
}

function getAgentCommand(
	agentName: AgentName,
	prompt: string,
): { cmd: string; args: string[] } {
	// Exhaustive check — if more agents are added, TypeScript will error here
	const _: 'claude' = agentName;
	void _;
	return { cmd: 'claude', args: ['-p', prompt] };
}

function logStartup(label: string): void {
	console.log(`[${label}] config=${CONFIG_DIR}`);
	console.log(`[${label}] data=${DATA_DIR}`);
	console.log(`[${label}] queue=${QUEUE_DIR}`);
}

function getToken(config: Config): string {
	const token = config.channels.telegram.token;
	if (!token) {
		console.error('Error: channels.telegram.token is not set in config.');
		console.error(`Set it in ${APP_CONFIG}`);
		Deno.exit(1);
	}
	return token;
}

function getJobDir(jobFile: string): string {
	return join(DATA_DIR, `${jobFile}.d`);
}

function getJobMeta(jobFile: string): string {
	return join(getJobDir(jobFile), 'meta.json');
}

function mimeToExt(mime: string | undefined, fallback: string): string {
	if (!mime) return fallback;

	const map: Record<string, string> = {
		'image/jpeg': '.jpg',
		'image/png': '.png',
		'image/gif': '.gif',
		'image/webp': '.webp',
		'audio/ogg': '.ogg',
		'audio/mpeg': '.mp3',
		'audio/mp4': '.m4a',
		'application/pdf': '.pdf',
		'text/plain': '.txt',
	};

	return map[mime] ?? fallback;
}

function getMsgType(message?: Partial<Message>): string {
	if (message?.text) return 'text';
	if (message?.photo) return 'photo';
	if (message?.document) {
		return `document(${message.document.file_name ?? '<unknown>'})`;
	}
	if (message?.video) return 'video';
	if (message?.voice) return 'voice';
	if (message?.audio) return 'audio';
	if (message?.sticker) return 'sticker';
	if (message?.reply_to_message) return 'reply';
	return 'other';
}

function extractAttachments(message?: Partial<Message>): AttachmentInfo[] {
	const attachments: AttachmentInfo[] = [];

	if (message?.photo && message.photo.length > 0) {
		const largest = message.photo.at(-1);
		attachments.push({
			fileId: largest?.file_id ?? '<unknown>',
			fileName: 'photo.jpg',
		});
	}

	if (message?.document) {
		const doc = message.document;
		const fileName = doc.file_name ?? `document${mimeToExt(doc.mime_type, '')}`;
		attachments.push({ fileId: doc.file_id, fileName });
	}

	if (message?.audio) {
		const audio = message.audio;
		const fileName = audio.file_name ??
			`audio${mimeToExt(audio.mime_type, '.mp3')}`;
		attachments.push({ fileId: audio.file_id, fileName });
	}

	if (message?.voice) {
		const voice = message.voice;
		const fileName = `voice${mimeToExt(voice.mime_type, '.ogg')}`;
		attachments.push({ fileId: voice.file_id, fileName });
	}

	return attachments;
}

async function downloadAttachment(
	bot: TelegramBot,
	fileId: string,
	dir: string,
	fileName: string,
): Promise<string> {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error(`No file_path returned for file_id: ${fileId}`);
	}
	const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to download file: ${response.status} ${response.statusText}`,
		);
	}
	const data = new Uint8Array(await response.arrayBuffer());
	const filePath = join(dir, fileName);
	await Deno.writeFile(filePath, data);
	return filePath;
}

export function createIngressHandler(
	bot: TelegramBot,
	allowedIds: Set<string>,
) {
	return async (ctx: IngressContext) => {
		const userId = ctx.from?.id;
		const chatId = ctx.chat?.id;
		const messageId = ctx.message?.message_id;
		const isAllowed = userId != null && allowedIds.has(String(userId));
		const isMissingId = chatId == null || messageId == null;
		const username = ctx.from?.username ?? '(unknown)';
		const text = ctx.message?.text ?? ctx.message?.caption ?? '';
		const attachments = extractAttachments(ctx.message);
		const msgType = getMsgType(ctx.message);

		const quote = ctx.message?.reply_to_message?.text ??
			ctx.message?.reply_to_message?.caption ??
			'';

		const details = [`type=${msgType}`];
		if (text) details.push(`text=${text}`);
		if (quote) details.push(`quote=${quote}`);
		if (attachments.length > 0) {
			details.push(`attachments=${attachments.length}`);
		}

		console.log(
			`[ingress] Message from ${username} (${userId}): ${details.join(', ')}`,
		);

		if (isMissingId || !isAllowed || (!text && attachments.length === 0)) {
			console.log(
				`[ingress] ${
					isMissingId ? '⚠️' : isAllowed ? '✅' : '⛔️'
				} Disallowed, malformed or empty message, skipping it`,
			);
			return;
		}

		await ctx.replyWithChatAction('typing');

		try {
			const channel = 'telegram';
			const sourceId = `${chatId}_${messageId}`;
			const messageDir = getMessageDir(channel, sourceId);
			await Deno.mkdir(messageDir, { recursive: true, mode: 0o755 });

			// Download attachments if present
			const attachmentPaths: string[] = [];

			if (attachments.length > 0) {
				const attachDir = join(messageDir, 'attachments');
				await Deno.mkdir(attachDir, { recursive: true, mode: 0o755 });

				for (const attach of attachments) {
					try {
						const path = await downloadAttachment(
							bot,
							attach.fileId,
							attachDir,
							attach.fileName,
						);
						attachmentPaths.push(path);
						console.log(`[ingress] Downloaded attachment: ${path}`);
					} catch (err) {
						console.error(
							`[ingress] Failed to download attachment ${attach.fileName}:`,
							err,
						);
					}
				}

				if (attachmentPaths.length === 0) {
					// Clean up empty attachments dir
					try {
						await Deno.remove(attachDir, { recursive: true });
					} catch {
						/* ignore */
					}

					// If attachment-only message and all downloads failed, skip
					if (!text) {
						await Deno.remove(messageDir, { recursive: true });
						return;
					}
				}
			}

			// Build prompt
			let prompt = text;
			if (quote) {
				prompt = `Quote: ${quote}\n\n${prompt}`;
			}
			if (attachmentPaths.length > 0) {
				const list = attachmentPaths
					.map((p, i) => `${i + 1}. @${p}`)
					.join('\n');
				prompt = `Attachments:\n${list}\n\n${prompt}`.trim();
			}

			await ctx.replyWithChatAction('typing');

			// Save prompt
			await Deno.writeTextFile(join(messageDir, 'prompt.txt'), prompt);

			// Enqueue via nq
			const nqCmd = new Deno.Command('nq', {
				args: [
					Deno.execPath(),
					'task',
					'--quiet',
					'cli',
					'dispatch',
					'--id',
					`${channel}:${sourceId}`,
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
			});

			const result = await nqCmd.output();
			const jobFile = new TextDecoder().decode(result.stdout).trim();

			if (!jobFile || !result.success) {
				console.error(
					'[ingress] nq failed:',
					new TextDecoder().decode(result.stderr),
				);
				return;
			}

			// Create jobId.d symlink to natural key directory
			const jobLink = join(DATA_DIR, `${jobFile}.d`);
			try {
				await Deno.symlink(messageDir, jobLink);
			} catch (err) {
				console.error(`[ingress] Failed to create symlink ${jobLink}:`, err);
			}

			const meta: JobMeta = {
				channel: 'telegram',
				chatId,
				messageId,
				userId,
			};

			await Deno.writeTextFile(
				join(messageDir, 'meta.json'),
				JSON.stringify(meta, null, 2),
			);

			console.log(`[ingress] Queued: ${jobFile} from user ${userId}`);
		} catch (err) {
			console.error('[ingress] Error:', err);
		}
	};
}

export async function ingress(): Promise<void> {
	const config = await loadConfig();
	const token = getToken(config);

	const allowedIds = new Set(config.allowedUsers.map((u) => u.userId));

	if (allowedIds.size === 0) {
		console.warn(
			'Warning: No allowed users configured. All messages will be ignored.',
		);
		console.warn(`Add users to ${APP_CONFIG}`);
	}

	const bot = new Bot(token);

	const handleMessage = createIngressHandler(bot, allowedIds);

	// Private chats: handle all messages
	bot.chatType('private').on('message', handleMessage);
	// Group chats: pre-filter to only messages with mentions
	bot.chatType(['group', 'supergroup']).on('::mention', handleMessage);

	logStartup('ingress');
	console.log(
		`[ingress] Allowed users: ${[...allowedIds].join(', ') || '(none)'}`,
	);
	console.log('[ingress] Waiting for Telegram messages... (Ctrl-C to stop)');

	await bot.start();
}

export async function egress(): Promise<void> {
	const config = await loadConfig();
	const token = getToken(config);
	const bot = new Bot(token);

	logStartup('egress');

	// Process any jobs that completed while react was not running
	await scanAndProcess(QUEUE_COMPLETED_DIR, bot);
	await scanAndProcess(QUEUE_FAILED_DIR, bot);

	console.log(
		'[egress] Watching for completed/failed jobs... (Ctrl-C to stop)',
	);

	// Guard against duplicate fs events for the same file
	const processing = new Set<string>();

	const watcher = Deno.watchFs([QUEUE_COMPLETED_DIR, QUEUE_FAILED_DIR]);

	for await (const event of watcher) {
		if (event.kind === 'access' || event.kind === 'other') continue;

		for (const path of event.paths) {
			const fileName = basename(path);
			if (!fileName.startsWith(',')) continue;
			if (processing.has(fileName)) continue;

			try {
				await Deno.stat(path);
				await Deno.stat(getJobMeta(fileName));
			} catch {
				continue;
			}

			processing.add(fileName);
			try {
				await processJob(dirname(path), fileName, bot);
			} catch (err) {
				console.error(`[egress] Error processing ${fileName}:`, err);
			} finally {
				processing.delete(fileName);
			}
		}
	}
}

async function sendSplitMessage(
	bot: TelegramBot,
	chatId: number,
	text: string,
	replyToMessageId: number,
) {
	const escapedOutput = convert(text, 'escape');
	const MAX_LENGTH = 4096;
	let remaining = escapedOutput;

	while (remaining.length > MAX_LENGTH) {
		let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
		if (splitIndex === -1) {
			splitIndex = MAX_LENGTH;
		}

		const chunk = remaining.slice(0, splitIndex).trim();
		if (chunk) {
			await bot.api.sendMessage(chatId, chunk, {
				reply_parameters: { message_id: replyToMessageId },
				parse_mode: 'MarkdownV2',
			});
		}
		remaining = remaining.slice(splitIndex).trim();
	}

	if (remaining) {
		await bot.api.sendMessage(chatId, remaining, {
			reply_parameters: { message_id: replyToMessageId },
			parse_mode: 'MarkdownV2',
		});
	}
}

async function scanAndProcess(
	scanDir: string,
	bot: TelegramBot,
): Promise<void> {
	try {
		// Collect and sort job files by name (`,HEXTIME.PID`) so they are
		// processed oldest-first, matching the order of shell glob `,*` used
		// in nqtail.sh.
		const jobs: string[] = [];
		for await (const entry of Deno.readDir(scanDir)) {
			if (!entry.isFile || !entry.name.startsWith(',')) continue;
			jobs.push(entry.name);
		}
		jobs.sort();

		for (const name of jobs) {
			try {
				await processJob(scanDir, name, bot);
			} catch (err) {
				console.error(`[egress] Error processing ${name}:`, err);
			}
		}
	} catch (err) {
		console.error('[egress] Scan error:', err);
	}
}

export async function processJob(
	scanDir: string,
	jobName: string,
	bot: TelegramBot,
): Promise<void> {
	const logPath = join(scanDir, jobName);
	const jobDir = getJobDir(jobName);
	const metaPath = getJobMeta(jobName);

	const meta: JobMeta = v.parse(
		JobMeta,
		JSON.parse(await Deno.readTextFile(metaPath)),
	);

	const raw = (await Deno.readTextFile(logPath)).trim();
	const firstNl = raw.indexOf('\n');
	const lastNl = raw.lastIndexOf('\n');
	const output = firstNl !== -1 && firstNl !== lastNl
		? raw.slice(firstNl + 1, lastNl).trim()
		: raw;

	if (!output) {
		console.log(`[egress] Empty output for ${jobName}, skipping`);
		return;
	}

	await bot.api.sendChatAction(meta.chatId, 'typing');

	await sendSplitMessage(bot, meta.chatId, output, meta.messageId);

	// Move job output file into .d/ directory (marks as processed)
	await Deno.rename(logPath, join(jobDir, jobName));

	// Clean up symlink if it exists
	const jobLink = join(DATA_DIR, `${jobName}.d`);
	try {
		const stat = await Deno.lstat(jobLink);
		if (stat.isSymlink) {
			await Deno.remove(jobLink);
		}
	} catch {
		// Ignore if not a symlink or doesn't exist (legacy .d directory)
	}

	console.log(`[egress] Sent response for ${jobName} to chat ${meta.chatId}`);
}

export async function dispatch(args: string[]): Promise<void> {
	const config = await loadConfig();
	const agentName = config.agent.name;

	let prompt: string;

	if (args.includes('--stdin')) {
		const buf = await new Response(Deno.stdin.readable).text();
		prompt = buf.trim();
	} else if (args.includes('--id')) {
		const idx = args.indexOf('--id');
		const fullId = args[idx + 1];
		if (!fullId) {
			console.error('Error: --id requires a <channel>:<id>.');
			Deno.exit(1);
		}
		const [channel, id] = fullId.split(':');
		if (!channel || !id) {
			console.error('Error: --id format must be <channel>:<id>.');
			Deno.exit(1);
		}
		const promptPath = join(getMessageDir(channel, id), 'prompt.txt');
		try {
			prompt = (await Deno.readTextFile(promptPath)).trim();
		} catch {
			console.error(`Error: message not found: ${promptPath}`);
			Deno.exit(1);
		}
	} else {
		prompt = args.join(' ');
		if (!prompt) {
			console.error('Error: no message provided.');
			console.error(
				'Usage: muxclaw dispatch <message> | --stdin | --id <channel>:<id>',
			);
			Deno.exit(1);
		}
	}

	const agent = getAgentCommand(agentName, prompt);

	const cmd = new Deno.Command(agent.cmd, {
		args: agent.args,
		cwd: getWorkspaceDir(config),
		stdin: 'null',
		stdout: 'inherit',
		stderr: 'inherit',
	});

	const result = await cmd.output();
	if (!result.success) {
		Deno.exit(result.code);
	}
}

function printHelp(): void {
	console.log(
		`
muxclaw — channel-to-coding-agent bridge

Usage:
  muxclaw                     Show this help
  muxclaw help                Show this help
  muxclaw ingress             Start ingress (channel → queue)
  muxclaw egress              Start egress reactor (queue → channel, watches continuously)
  muxclaw dispatch <message>   Dispatch message to configured agent
  muxclaw dispatch --stdin     Read message from stdin
  muxclaw dispatch --id <chan>:<id> Read message from natural key store
`.trim(),
	);
}

async function ensureDirs(): Promise<void> {
	await Promise.all([
		Deno.mkdir(CONFIG_DIR, { recursive: true }),
		Deno.mkdir(DATA_DIR, { recursive: true }),
		Deno.mkdir(QUEUE_COMPLETED_DIR, { recursive: true }),
		Deno.mkdir(QUEUE_FAILED_DIR, { recursive: true }),
	]);
}

async function main() {
	const [command, ...rest] = Deno.args;

	if (!command || command.toLowerCase() === 'help') {
		printHelp();
		return;
	}

	await ensureDirs();

	const config = await loadConfig();
	await validateWorkspace(config);

	switch (command.toLowerCase()) {
		case 'ingress':
			await ingress();
			break;
		case 'egress':
			await egress();
			break;
		case 'dispatch':
			await dispatch(rest);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			Deno.exit(1);
	}
}

if (import.meta.main) {
	main();
}
