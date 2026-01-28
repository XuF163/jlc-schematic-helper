import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WsBridge } from '../bridge/wsBridge.js';
import { parseNetlist } from '../netlist/parseNetlist.js';
import { parseJlcJsonNetlist, type JlcNetlistComponent } from '../netlist/parseJlcJsonNetlist.js';

type ToolHandlerResult = { content: Array<{ type: 'text'; text: string }> };

export type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: unknown;
	run: (args: unknown) => Promise<ToolHandlerResult>;
};

function asJsonText(value: unknown): ToolHandlerResult {
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify(value, null, 2),
			},
		],
	};
}

const EmptySchema = z.object({});

const ShowMessageSchema = z.object({
	message: z.string().min(1),
});

const NetlistTypeSchema = z.enum(['JLCEDA', 'EasyEDA', 'Protel2', 'PADS', 'Allegro', 'DISA']).optional();

const ExportEnetSchema = z.object({
	netlistType: NetlistTypeSchema,
	savePath: z.string().min(1).optional(),
	fileName: z.string().min(1).optional(),
	force: z.boolean().optional(),
	includeRaw: z.boolean().optional().default(true),
	maxCharsRaw: z.number().int().positive().optional().default(200_000),
	parse: z.boolean().optional().default(true),
});

const GetEnetJsonSchema = z.object({
	netlistType: NetlistTypeSchema,
	savePath: z.string().min(1).optional(),
	fileName: z.string().min(1).optional(),
	force: z.boolean().optional(),
	// Output scaling (server-side). Defaults are intentionally conservative for LLM context.
	detail: z.enum(['summary', 'standard', 'full']).optional().default('standard'),
	limits: z
		.object({
			maxNets: z.number().int().positive().optional(),
			maxNodesPerNet: z.number().int().positive().optional(),
			maxComponents: z.number().int().positive().optional(),
			maxPinsPerComponent: z.number().int().positive().optional(),
			maxCharsRaw: z.number().int().positive().optional(),
		})
		.optional(),
	includeRaw: z.boolean().optional().default(false),
});

function guessIsText(buf: Buffer): boolean {
	// Heuristic: reject NUL bytes early; count non-printable chars in a small sample.
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	let nonPrintable = 0;
	for (const b of sample) {
		if (b === 0) return false;
		// allow: tab(9), lf(10), cr(13)
		if (b === 9 || b === 10 || b === 13) continue;
		// printable ASCII range
		if (b >= 32 && b <= 126) continue;
		// other bytes (likely UTF-8 multibyte or binary)
		nonPrintable++;
	}
	return sample.length === 0 ? true : nonPrintable / sample.length < 0.2;
}

async function readFileSmart(filePath: string, maxChars: number): Promise<{
	encoding: 'utf8' | 'base64';
	truncated: boolean;
	totalBytes: number;
	text?: string;
	base64?: string;
}> {
	const buf = await fs.readFile(filePath);
	const totalBytes = buf.length;

	if (!guessIsText(buf)) {
		// Base64-encode a limited prefix to avoid huge MCP payloads.
		const maxBytes = Math.min(totalBytes, Math.max(1024, Math.min(256_000, maxChars * 2)));
		const prefix = buf.subarray(0, maxBytes);
		return {
			encoding: 'base64',
			truncated: maxBytes < totalBytes,
			totalBytes,
			base64: prefix.toString('base64'),
		};
	}

	const text = buf.toString('utf8');
	if (text.length <= maxChars) {
		return { encoding: 'utf8', truncated: false, totalBytes, text };
	}
	return { encoding: 'utf8', truncated: true, totalBytes, text: text.slice(0, Math.floor(maxChars)) };
}

function toNetArray(nets: Record<string, Array<{ ref: string; pin: string }>>, limits?: { maxNets?: number; maxNodesPerNet?: number }) {
	const entries = Object.entries(nets);
	entries.sort((a, b) => a[0].localeCompare(b[0]));

	const limited = typeof limits?.maxNets === 'number' ? entries.slice(0, limits.maxNets) : entries;
	return limited.map(([name, nodes]) => ({
		name,
		nodes:
			typeof limits?.maxNodesPerNet === 'number'
				? nodes.slice(0, limits.maxNodesPerNet)
				: nodes,
	}));
}

function toComponentArray(
	comps: Array<JlcNetlistComponent>,
	opts: { detail: 'summary' | 'standard' | 'full'; limits?: { maxComponents?: number; maxPinsPerComponent?: number } },
): Array<unknown> {
	const sorted = [...comps].sort((a, b) => a.ref.localeCompare(b.ref));
	const limited = typeof opts.limits?.maxComponents === 'number' ? sorted.slice(0, opts.limits.maxComponents) : sorted;
	const maxPins = opts.limits?.maxPinsPerComponent;

	return limited.map((c) => {
		const pins = typeof maxPins === 'number' ? c.pins.slice(0, maxPins) : c.pins;

		if (opts.detail === 'summary') {
			return {
				ref: c.ref,
				value: c.value,
				footprintName: c.footprintName,
				lcsc: c.lcsc,
				manufacturer: c.manufacturer,
				mpn: c.mpn,
				datasheetUrl: c.datasheetUrl,
				jlcpcbPartClass: c.jlcpcbPartClass,
			};
		}

		if (opts.detail === 'standard') {
			return {
				ref: c.ref,
				value: c.value,
				footprintName: c.footprintName,
				lcsc: c.lcsc,
				manufacturer: c.manufacturer,
				mpn: c.mpn,
				datasheetUrl: c.datasheetUrl,
				jlcpcbPartClass: c.jlcpcbPartClass,
				pins: pins.map((p) => ({ pin: p.pin, net: p.net, name: p.name })),
			};
		}

		// full
		return {
			ref: c.ref,
			value: c.value,
			footprintName: c.footprintName,
			lcsc: c.lcsc,
			manufacturer: c.manufacturer,
			mpn: c.mpn,
			datasheetUrl: c.datasheetUrl,
			jlcpcbPartClass: c.jlcpcbPartClass,
			pins: pins.map((p) => ({ pin: p.pin, net: p.net, name: p.name })),
			props: c.props,
		};
	});
}

function safeFileName(value: string): string {
	// Windows filename restrictions: \ / : * ? " < > |
	return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function getTimestampForFileName(): string {
	return safeFileName(new Date().toISOString());
}

async function writeTextFile(opts: { savePath?: string; fileName: string; force?: boolean; text: string }): Promise<string> {
	const force = opts.force ?? true;
	const baseDir = path.resolve(opts.savePath ?? path.join(process.cwd(), 'artifacts'));
	await fs.mkdir(baseDir, { recursive: true });

	const fileName = safeFileName(opts.fileName);
	const fullPath = path.join(baseDir, fileName);

	if (!force) {
		try {
			await fs.access(fullPath);
			throw new Error(`File already exists (force=false): ${fullPath}`);
		} catch (err: any) {
			// ok when the file does not exist
			if (err && typeof err === 'object' && 'code' in err && (err as any).code === 'ENOENT') {
				// continue
			} else {
				throw err;
			}
		}
	}

	await fs.writeFile(fullPath, opts.text, 'utf8');
	return fullPath;
}

async function getNetlistText(
	bridge: WsBridge,
	opts?: { netlistType?: string; timeoutMs?: number },
): Promise<{ netlistType: string; netlist: string; truncated: boolean; totalChars: number }> {
	const netlistType = (opts?.netlistType ?? 'EasyEDA').trim() || 'EasyEDA';
	const timeoutMs = opts?.timeoutMs ?? 120_000;

	const res = (await bridge.call(
		'schematic.getNetlist',
		{ netlistType, timeoutMs },
		Math.max(10_000, timeoutMs + 5_000),
	)) as any;

	const netlist = typeof res?.netlist === 'string' ? res.netlist : '';
	const totalChars = typeof res?.totalChars === 'number' ? res.totalChars : netlist.length;
	const truncated = Boolean(res?.truncated);
	const actualType = typeof res?.netlistType === 'string' ? res.netlistType : netlistType;
	return { netlistType: actualType, netlist, truncated, totalChars };
}

export function createToolRegistry(bridge: WsBridge): Array<ToolDefinition> {
	return [
		{
			name: 'jlc.status',
			description: 'Get local bridge status (WebSocket listening port + EDA connection state).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			run: async (_args) => {
				return asJsonText(bridge.getStatus());
			},
		},
		{
			name: 'jlc.bridge.ping',
			description: 'Ping EDA extension via the local WebSocket bridge.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			run: async (args) => {
				EmptySchema.parse(args);
				const result = await bridge.call('ping', undefined, 5_000);
				return asJsonText({ ok: true, result });
			},
		},
		{
			name: 'jlc.bridge.show_message',
			description: 'Show a message in JLCEDA UI (toast preferred).',
			inputSchema: {
				type: 'object',
				properties: {
					message: { type: 'string' },
				},
				required: ['message'],
				additionalProperties: false,
			},
			run: async (args) => {
				const parsed = ShowMessageSchema.parse(args);
				const result = await bridge.call('showMessage', parsed, 10_000);
				return asJsonText(result ?? { ok: true });
			},
		},
		{
			name: 'jlc.schematic.export_enet',
			description: 'Export EasyEDA Pro netlist (.enet) from current schematic page and save to file system.',
			inputSchema: {
				type: 'object',
				properties: {
					netlistType: { type: 'string', enum: ['JLCEDA', 'EasyEDA', 'Protel2', 'PADS', 'Allegro', 'DISA'] },
					savePath: { type: 'string' },
					fileName: { type: 'string' },
					force: { type: 'boolean' },
					includeRaw: { type: 'boolean' },
					maxCharsRaw: { type: 'number' },
					parse: { type: 'boolean' },
				},
				additionalProperties: false,
			},
			run: async (args) => {
				const parsed = ExportEnetSchema.parse(args);
				const netlistType = parsed.netlistType ?? 'EasyEDA';
				const netlistRes = await getNetlistText(bridge, { netlistType, timeoutMs: 120_000 });
				if (!netlistRes.netlist) {
					return asJsonText({ ok: false, error: 'No netlist text returned from EDA.', netlist: netlistRes });
				}

				const ext = netlistType === 'EasyEDA' ? '.enet' : '.net';
				const fileName = safeFileName(parsed.fileName ?? `jlceda_schematic_helper_netlist_${getTimestampForFileName()}${ext}`);
				const savedTo = await writeTextFile({
					savePath: parsed.savePath,
					fileName,
					force: parsed.force,
					text: netlistRes.netlist,
				});

				const maxCharsRaw = parsed.maxCharsRaw;
				const raw =
					parsed.includeRaw
						? {
								encoding: 'utf8' as const,
								truncated: netlistRes.netlist.length > maxCharsRaw,
								totalBytes: Buffer.byteLength(netlistRes.netlist, 'utf8'),
								text:
									netlistRes.netlist.length > maxCharsRaw ? netlistRes.netlist.slice(0, Math.floor(maxCharsRaw)) : netlistRes.netlist,
							}
						: undefined;

				let parsedNetlist: unknown = undefined;
				if (parsed.parse) {
					parsedNetlist = parseJlcJsonNetlist(netlistRes.netlist) ?? parseNetlist(netlistRes.netlist);
				}

				return asJsonText({
					ok: true,
					exported: { savedTo, fileName, netlistType: netlistRes.netlistType, source: 'api' },
					raw,
					parsed: parsedNetlist,
				});
			},
		},
		{
			name: 'jlc.schematic.get_enet_json',
			description:
				'Export .enet and convert to JSON for LLM consumption. Use detail/limits/includeRaw to control output size.',
			inputSchema: {
				type: 'object',
				properties: {
					netlistType: { type: 'string', enum: ['JLCEDA', 'EasyEDA', 'Protel2', 'PADS', 'Allegro', 'DISA'] },
					savePath: { type: 'string' },
					fileName: { type: 'string' },
					force: { type: 'boolean' },
					detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
					limits: {
						type: 'object',
						properties: {
							maxNets: { type: 'number' },
							maxNodesPerNet: { type: 'number' },
							maxComponents: { type: 'number' },
							maxPinsPerComponent: { type: 'number' },
							maxCharsRaw: { type: 'number' },
						},
						additionalProperties: false,
					},
					includeRaw: { type: 'boolean' },
				},
				additionalProperties: false,
			},
			run: async (args) => {
				const input = GetEnetJsonSchema.parse(args);
				const netlistType = input.netlistType ?? 'EasyEDA';
				const netlistRes = await getNetlistText(bridge, { netlistType, timeoutMs: 120_000 });
				if (!netlistRes.netlist) {
					return asJsonText({ ok: false, error: 'No netlist text returned from EDA.', netlist: netlistRes });
				}

				let savedTo: string | undefined;
				let savedFileName: string | undefined;
				// Only write to disk if the caller asked for it.
				if (input.savePath || input.fileName) {
					const ext = netlistType === 'EasyEDA' ? '.enet' : '.net';
					savedFileName = safeFileName(input.fileName ?? `jlceda_schematic_helper_netlist_${getTimestampForFileName()}${ext}`);
					savedTo = await writeTextFile({
						savePath: input.savePath,
						fileName: savedFileName,
						force: input.force,
						text: netlistRes.netlist,
					});
				}

				const maxCharsRaw = input.limits?.maxCharsRaw ?? (input.includeRaw ? 200_000 : 0);
				const raw =
					input.includeRaw
						? {
								encoding: 'utf8' as const,
								truncated: netlistRes.netlist.length > maxCharsRaw,
								totalBytes: Buffer.byteLength(netlistRes.netlist, 'utf8'),
								text:
									netlistRes.netlist.length > maxCharsRaw ? netlistRes.netlist.slice(0, Math.floor(maxCharsRaw)) : netlistRes.netlist,
							}
						: undefined;

				const parsedJson = parseJlcJsonNetlist(netlistRes.netlist);

				let netsRecord: Record<string, Array<{ ref: string; pin: string }>> = {};
				let componentsArray: Array<unknown> = [];
				const warnings: Array<string> = [];

				if (parsedJson) {
					netsRecord = parsedJson.nets;
					componentsArray = toComponentArray(parsedJson.components, {
						detail: input.detail,
						limits: { maxComponents: input.limits?.maxComponents, maxPinsPerComponent: input.limits?.maxPinsPerComponent },
					});
					if (parsedJson.warnings?.length) warnings.push(...parsedJson.warnings);
				} else {
					const parsedText = parseNetlist(netlistRes.netlist);
					netsRecord = parsedText.nets;
					if (parsedText.warnings?.length) warnings.push(...parsedText.warnings);
				}

				const netsArray = toNetArray(netsRecord, input.limits);

				const enetJson = {
					format: 'enet',
					meta: {
						generatedAt: new Date().toISOString(),
						sourceFile: savedTo,
						fileName: savedFileName,
						netlistType: netlistRes.netlistType,
						truncated: netlistRes.truncated,
						totalChars: netlistRes.totalChars,
						components: parsedJson ? parsedJson.components.length : undefined,
						nets: Object.keys(netsRecord).length,
					},
					components: componentsArray,
					nets: netsArray,
					warnings,
				};

				if (input.detail === 'summary') {
					return asJsonText({
						...enetJson,
						nets: netsArray.slice(0, 50).map((n) => ({ name: n.name, nodes: n.nodes.slice(0, 10) })),
						components: componentsArray.slice(0, 50),
					});
				}

				return asJsonText({
					...enetJson,
					raw,
				});
			},
		},
	];
}
