import type { WsBridge } from './bridge/wsBridge.js';

async function delay(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

export async function runSelfTest(bridge: WsBridge, opts: { timeoutMs: number }): Promise<unknown> {
	const deadline = Date.now() + Math.max(1_000, opts.timeoutMs);

	while (Date.now() < deadline) {
		if (bridge.getStatus().connected) break;
		await delay(250);
	}

	const status = bridge.getStatus();
	if (!status.connected) {
		return { ok: false, error: 'Timeout waiting for EDA extension connection', status };
	}

	try {
		const ping = await bridge.call('ping', undefined, 5_000);
		return { ok: true, status, ping };
	} catch (err) {
		return { ok: false, status, error: err instanceof Error ? err.message : String(err) };
	}
}

