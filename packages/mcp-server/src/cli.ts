#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs/promises';

import { WsBridge } from './bridge/wsBridge.js';
import { runMcpServer } from './mcpServer.js';
import { runSelfTest } from './selfTest.js';
import { createToolRegistry } from './tools/toolRegistry.js';

function getArgValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i === -1) return undefined;
	return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

function parsePort(value: string | undefined): number {
	if (!value) return 9050;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`Invalid port: ${value}`);
	return n;
}

function parseTimeoutMs(value: string | undefined, defaultValue: number): number {
	if (!value) return defaultValue;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid timeout ms: ${value}`);
	return Math.floor(n);
}

function countTruthy(values: Array<unknown>): number {
	return values.reduce<number>((acc, v) => acc + (v ? 1 : 0), 0);
}

async function parseParams(
	kind: 'call' | 'tool',
	opts: { raw?: string; file?: string },
): Promise<unknown> {
	if (countTruthy([opts.raw, opts.file]) > 1) {
		throw new Error('Provide only one of --params or --params-file');
	}

	const defaultValue = kind === 'call' ? undefined : {};
	if (!opts.raw && !opts.file) return defaultValue;

	let text = opts.raw;
	if (!text && opts.file) {
		text = await fs.readFile(opts.file, 'utf8');
	}

	if (!text) return defaultValue;

	// PowerShell on Windows may write UTF-8 with BOM by default.
	text = text.replace(/^\uFEFF/, '').trim();

	try {
		return JSON.parse(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid params JSON: ${msg}`);
	}
}

async function requestExtensionDisconnect(bridge: WsBridge): Promise<void> {
	try {
		await bridge.call('bridge.disconnect', undefined, 2_000);
	} catch {
		// ignore (e.g. not connected / extension doesn't support the method yet)
	}
}

async function waitConnected(bridge: WsBridge, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(1_000, timeoutMs);
	while (Date.now() < deadline) {
		if (bridge.getStatus().connected) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return bridge.getStatus().connected;
}

async function main(): Promise<void> {
	const port = parsePort(getArgValue('--port') ?? process.env.JLCEDA_SCH_HELPER_PORT ?? process.env.JLCEDA_MCP_PORT);

	const selfTest = hasFlag('--self-test') || (process.env.JLCEDA_SCH_HELPER_SELF_TEST ?? '') === '1';
	const selfTestTimeoutMs = parseTimeoutMs(
		getArgValue('--self-test-timeout-ms') ?? process.env.JLCEDA_SCH_HELPER_SELF_TEST_TIMEOUT_MS,
		60_000,
	);

	const callMethod = getArgValue('--call');
	const toolName = getArgValue('--tool');
	const callParamsRaw = getArgValue('--params');
	const callParamsFile = getArgValue('--params-file');
	const callWaitMs = parseTimeoutMs(getArgValue('--wait-ms'), 60_000);
	const callTimeoutMs = parseTimeoutMs(getArgValue('--timeout-ms'), 120_000);

	process.stderr.write(`[jlceda-schematic-helper] WebSocket listening on ws://127.0.0.1:${port}\n`);

	const bridge = new WsBridge({
		port,
		log: (line) => process.stderr.write(`${line}\n`),
	});

	const onSignal = () => {
		try {
			bridge.close();
		} finally {
			process.exit(0);
		}
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	if (callMethod && toolName) {
		process.stderr.write(`[jlceda-schematic-helper] Provide either --call or --tool, not both.\n`);
		bridge.close();
		process.exit(2);
	}

	if (callMethod) {
		process.stderr.write(`[jlceda-schematic-helper] Call mode: method=${callMethod}\n`);
		const ok = await waitConnected(bridge, callWaitMs);
		if (!ok) {
			process.stderr.write(`[jlceda-schematic-helper] Timeout waiting for EDA extension connection.\n`);
			bridge.close();
			process.exit(2);
		}

		let callParams: unknown = undefined;
		try {
			callParams = await parseParams('call', { raw: callParamsRaw, file: callParamsFile });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[jlceda-schematic-helper] ${msg}\n`);
			bridge.close();
			process.exit(2);
		}

			const result = await bridge.call(callMethod, callParams, callTimeoutMs);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			await requestExtensionDisconnect(bridge);
			bridge.close();
			return;
		}

	if (toolName) {
		process.stderr.write(`[jlceda-schematic-helper] Tool mode: tool=${toolName}\n`);
		const ok = await waitConnected(bridge, callWaitMs);
		if (!ok) {
			process.stderr.write(`[jlceda-schematic-helper] Timeout waiting for EDA extension connection.\n`);
			bridge.close();
			process.exit(2);
		}

		let callParams: unknown = {};
		try {
			callParams = await parseParams('tool', { raw: callParamsRaw, file: callParamsFile });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[jlceda-schematic-helper] ${msg}\n`);
			bridge.close();
			process.exit(2);
		}

		const tools = createToolRegistry(bridge);
		const tool = tools.find((t) => t.name === toolName);
		if (!tool) {
			process.stderr.write(`[jlceda-schematic-helper] Unknown tool: ${toolName}\n`);
			process.stderr.write(`[jlceda-schematic-helper] Available tools:\n`);
			for (const t of tools) process.stderr.write(`- ${t.name}\n`);
			bridge.close();
			process.exit(2);
		}

		const result = await Promise.race([
			tool.run(callParams),
			new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool timeout: ${toolName}`)), callTimeoutMs)),
		]);

		// Print plain text content when possible (tools generally return JSON text).
		const anyRes = result as any;
		const content = Array.isArray(anyRes?.content) ? anyRes.content : [];
		const texts = content
			.filter((c: any) => c?.type === 'text' && typeof c?.text === 'string')
			.map((c: any) => c.text);
		if (texts.length) process.stdout.write(`${texts.join('\n')}\n`);
		else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

		await requestExtensionDisconnect(bridge);
		bridge.close();
		return;
	}

	if (selfTest) {
		process.stderr.write('[jlceda-schematic-helper] Self-test mode: waiting for EDA extension connection...\n');
		const result = await runSelfTest(bridge, { timeoutMs: selfTestTimeoutMs });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		await requestExtensionDisconnect(bridge);
		bridge.close();
		return;
	}

	await runMcpServer({ bridge });
}

void main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.stack ?? err.message : String(err);
	process.stderr.write(`[jlceda-schematic-helper] Fatal: ${msg}\n`);
	process.exit(1);
});
