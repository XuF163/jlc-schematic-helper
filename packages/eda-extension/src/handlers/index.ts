import type { BridgeStatusSnapshot } from '../bridge/wsClient';
import { showToast } from '../bridge/ui';
import { asObject, asString, rpcError } from '../bridge/validate';

import { exportEnetFile, getNetlist } from './schematic';

export async function handleRpc(
	method: string,
	params: unknown,
	ctx: { getStatus: () => BridgeStatusSnapshot; requestDisconnect?: () => void },
): Promise<unknown> {
	switch (method) {
		case 'ping':
			return { ok: true, ts: Date.now() };
		case 'getStatus':
			return ctx.getStatus();
		case 'bridge.disconnect':
			// Must respond first; disconnect is scheduled so the response can be sent.
			ctx.requestDisconnect?.();
			return { ok: true };
		case 'showMessage': {
			const input = params ? asObject(params, 'params') : {};
			const message = asString(input.message, 'message');
			showToast(message, 'info', 4);
				return { ok: true };
			}
			case 'schematic.getNetlist':
				return await getNetlist(params);
			case 'schematic.exportEnetFile':
				return await exportEnetFile(params);
			default:
				throw rpcError('NOT_SUPPORTED', `Unknown method: ${method}`);
		}
}
