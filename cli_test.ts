import { assertEquals } from '@std/assert';

Deno.test('displays help', async () => {
	const command = new Deno.Command(Deno.execPath(), {
		args: [
			'task',
			'cli',
		],
		stdout: 'piped',
		stderr: 'piped',
	});

	const { code, stdout } = await command.output();
	const output = new TextDecoder().decode(stdout);

	assertEquals(code, 0);

	assertEquals(
		output,
		`muxclaw — channel-to-coding-agent bridge

Usage:
  muxclaw                     Show this help
  muxclaw help                Show this help
  muxclaw ingress             Start ingress (channel → queue)
  muxclaw egress              Start egress reactor (queue → channel, watches continuously)
  muxclaw dispatch <message>   Dispatch message to configured agent
  muxclaw dispatch --stdin     Read message from stdin
  muxclaw dispatch --id <chan>:<id> Read message from natural key store
`,
	);
});
