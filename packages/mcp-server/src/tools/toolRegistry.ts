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

const SearchDevicesSchema = z.object({
	key: z.string().min(1),
	libraryUuid: z.string().min(1).optional(),
	page: z.number().int().positive().optional(),
	limit: z.number().int().positive().max(100).optional(),
});

const GetDeviceSchema = z.object({
	deviceUuid: z.string().min(1),
	libraryUuid: z.string().min(1).optional(),
});

const PartsSearchSchema = z.object({
	query: z.string().min(1),
	source: z.enum(['eda']).optional().default('eda'),
	libraryUuid: z.string().min(1).optional(),
	page: z.number().int().positive().optional().default(1),
	limit: z.number().int().positive().max(50).optional().default(10),
	detail: z.enum(['summary', 'standard', 'full']).optional().default('standard'),
	requireDatasheet: z.boolean().optional().default(false),
	includeRaw: z.boolean().optional().default(false),
});

const PartsPickSchema = z
	.object({
		query: z.string().min(1).optional(),
		fromComponent: z
			.object({
				value: z.string().min(1).optional(),
				footprintName: z.string().min(1).optional(),
				manufacturer: z.string().min(1).optional(),
				mpn: z.string().min(1).optional(),
				lcsc: z.string().min(1).optional(),
			})
			.optional(),
		source: z.enum(['eda']).optional().default('eda'),
		libraryUuid: z.string().min(1).optional(),
		page: z.number().int().positive().optional().default(1),
		searchLimit: z.number().int().positive().max(100).optional().default(30),
		limit: z.number().int().positive().max(20).optional().default(5),
		requireDatasheet: z.boolean().optional().default(true),
		constraints: z
			.object({
				footprintName: z.string().min(1).optional(),
				requireFootprintMatch: z.boolean().optional().default(false),
				manufacturer: z.string().min(1).optional(),
				requireManufacturerMatch: z.boolean().optional().default(false),
			})
			.optional(),
		detail: z.enum(['summary', 'standard', 'full']).optional().default('standard'),
		includeRaw: z.boolean().optional().default(false),
	})
	.superRefine((v, ctx) => {
		if (v.query) return;
		const fc = v.fromComponent;
		const hasAny =
			Boolean(fc?.lcsc?.trim()) ||
			Boolean(fc?.mpn?.trim()) ||
			Boolean(fc?.manufacturer?.trim()) ||
			Boolean(fc?.value?.trim()) ||
			Boolean(fc?.footprintName?.trim());
		if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide query or fromComponent with at least one field' });
	});

const DatasheetSchema = z
	.object({
		url: z.string().min(1).optional(),
		deviceUuid: z.string().min(1).optional(),
		libraryUuid: z.string().min(1).optional(),
		download: z.boolean().optional().default(false),
		savePath: z.string().min(1).optional(),
		fileName: z.string().min(1).optional(),
		force: z.boolean().optional(),
		includeFile: z.boolean().optional().default(false),
		includeRawDevice: z.boolean().optional().default(false),
		maxCharsFile: z.number().int().positive().optional().default(200_000),
	})
	.superRefine((v, ctx) => {
		if (!v.url && !v.deviceUuid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide url or deviceUuid' });
	});

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown> | undefined, keys: Array<string>): string | undefined {
	if (!obj) return undefined;
	for (const k of keys) {
		const v = (obj as any)[k];
		if (typeof v === 'string' && v.trim()) return v;
	}
	return undefined;
}

function deepFindStringByKey(obj: unknown, keySubstr: string, maxDepth = 4): string | undefined {
	const needle = keySubstr.toLowerCase();
	const queue: Array<{ v: unknown; depth: number }> = [{ v: obj, depth: 0 }];
	const seen = new Set<unknown>();

	while (queue.length) {
		const cur = queue.shift()!;
		if (cur.depth > maxDepth) continue;
		const rec = asRecord(cur.v);
		if (!rec) continue;
		if (seen.has(rec)) continue;
		seen.add(rec);

		for (const [k, v] of Object.entries(rec)) {
			if (k.toLowerCase().includes(needle) && typeof v === 'string' && v.trim()) return v;
			if (cur.depth < maxDepth && v && typeof v === 'object') queue.push({ v, depth: cur.depth + 1 });
		}
	}

	return undefined;
}

function extractDatasheetUrl(obj: unknown): string | undefined {
	const rec = asRecord(obj);
	const direct = pickString(rec, ['datasheet', 'datasheetUrl', 'datasheetURL', 'Datasheet', 'dataSheet', 'dataSheetUrl', 'url']);
	if (direct && /^https?:\/\//i.test(direct)) return direct;

	const deep = deepFindStringByKey(obj, 'datasheet', 5);
	if (deep && /^https?:\/\//i.test(deep)) return deep;

	return undefined;
}

function extractMpn(obj: unknown): string | undefined {
	const rec = asRecord(obj);
	const direct =
		pickString(rec, [
			'mpn',
			'MPN',
			'manufacturerId',
			'manufacturerPart',
			'manufacturerPartNumber',
			'Manufacturer Part',
		]) ?? deepFindStringByKey(obj, 'manufacturer part', 6);
	return direct && typeof direct === 'string' && direct.trim() ? direct : undefined;
}

function extractLcsc(obj: unknown): string | undefined {
	const rec = asRecord(obj);
	const direct =
		pickString(rec, ['lcsc', 'LCSC', 'supplierId', 'supplierPart', 'supplierPartNumber', 'Supplier Part']) ??
		deepFindStringByKey(obj, 'supplier part', 6);
	return direct && typeof direct === 'string' && direct.trim() ? direct : undefined;
}

function summarizeDevice(device: unknown, fallback: { deviceUuid?: string; libraryUuid?: string }): Record<string, unknown> {
	const rec = asRecord(device) ?? {};
	const deviceUuid = pickString(rec, ['uuid', 'deviceUuid', 'device_uuid', 'id']) ?? fallback.deviceUuid ?? '';
	const libraryUuid = pickString(rec, ['libraryUuid', 'library_uuid']) ?? fallback.libraryUuid;
	const name = pickString(rec, ['name', 'title', 'deviceName', 'displayName']) ?? pickString(rec, ['key']) ?? '';
	const manufacturer = pickString(rec, ['manufacturer', 'Manufacturer']);
	const mpn = extractMpn(device);
	const lcsc = extractLcsc(device);
	const footprintName = pickString(rec, ['footprintName', 'package', 'footprint', 'FootprintName', 'Supplier Footprint']);
	const datasheetUrl = extractDatasheetUrl(device);
	const summary = pickString(rec, ['description', 'summary', 'desc']);

	return {
		deviceUuid,
		libraryUuid,
		name,
		manufacturer,
		mpn,
		lcsc,
		footprintName,
		datasheetUrl,
		summary,
	};
}

function resolvePdfUrlFromHtml(html: string, baseUrl: string): string | undefined {
	// Absolute URLs first.
	const abs = Array.from(html.matchAll(/https?:\/\/[^\s"'<>]+?\.pdf(?:\?[^\s"'<>]*)?/gi)).map((m) => m[0]);
	if (abs.length) return abs[0];

	// Then any quoted .pdf href/src (may be relative).
	const rel = Array.from(html.matchAll(/["']([^"'<>]+?\.pdf(?:\?[^"'<>]*)?)["']/gi)).map((m) => m[1]);
	for (const href of rel) {
		try {
			return new URL(href, baseUrl).toString();
		} catch {
			// ignore
		}
	}

	return undefined;
}

async function writeBinaryFile(opts: { savePath?: string; fileName: string; force?: boolean; data: Uint8Array }): Promise<string> {
	const force = opts.force ?? true;
	const baseDir = path.resolve(opts.savePath ?? path.join(process.cwd(), 'artifacts', 'datasheets'));
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

	await fs.writeFile(fullPath, opts.data);
	return fullPath;
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
		{
			name: 'jlc.library.search_devices',
			description: 'Search built-in JLCEDA device library (raw output).',
			inputSchema: {
				type: 'object',
				properties: {
					key: { type: 'string' },
					libraryUuid: { type: 'string' },
					page: { type: 'number' },
					limit: { type: 'number' },
				},
				required: ['key'],
				additionalProperties: false,
			},
			run: async (args) => {
				const input = SearchDevicesSchema.parse(args);
				try {
					const result = await bridge.call('library.searchDevices', input, 60_000);
					return asJsonText(result);
				} catch (err: any) {
					if (err?.code === 'NOT_SUPPORTED') {
						return asJsonText({
							ok: false,
							error: 'EDA extension is too old (missing method library.searchDevices). Please install the latest .eext bridge extension.',
							connectedApp: bridge.getStatus().client?.app ?? null,
							details: { code: err?.code, message: err?.message, data: err?.data },
						});
					}
					throw err;
				}
			},
		},
		{
			name: 'jlc.library.get_device',
			description: 'Get built-in JLCEDA device detail by deviceUuid (raw output).',
			inputSchema: {
				type: 'object',
				properties: {
					deviceUuid: { type: 'string' },
					libraryUuid: { type: 'string' },
				},
				required: ['deviceUuid'],
				additionalProperties: false,
			},
			run: async (args) => {
				const input = GetDeviceSchema.parse(args);
				try {
					const result = await bridge.call('library.getDevice', input, 60_000);
					return asJsonText(result);
				} catch (err: any) {
					if (err?.code === 'NOT_SUPPORTED') {
						return asJsonText({
							ok: false,
							error: 'EDA extension is too old (missing method library.getDevice). Please install the latest .eext bridge extension.',
							connectedApp: bridge.getStatus().client?.app ?? null,
							details: { code: err?.code, message: err?.message, data: err?.data },
						});
					}
					throw err;
				}
			},
		},
		{
			name: 'jlc.parts.search',
			description: 'Search candidate parts for selection (includes datasheetUrl when available).',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					source: { type: 'string', enum: ['eda'] },
					libraryUuid: { type: 'string' },
					page: { type: 'number' },
					limit: { type: 'number' },
					detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
					requireDatasheet: { type: 'boolean' },
					includeRaw: { type: 'boolean' },
				},
				required: ['query'],
				additionalProperties: false,
			},
			run: async (args) => {
				const input = PartsSearchSchema.parse(args);
				if (input.source !== 'eda') {
					return asJsonText({ ok: false, error: `Unsupported source: ${input.source}` });
				}

				let res: any;
				try {
					res = (await bridge.call(
						'library.searchDevices',
						{ key: input.query, libraryUuid: input.libraryUuid, page: input.page, limit: input.limit },
						60_000,
					)) as any;
				} catch (err: any) {
					if (err?.code === 'NOT_SUPPORTED') {
						return asJsonText({
							ok: false,
							error: 'EDA extension is too old (missing method library.searchDevices). Please install the latest .eext bridge extension.',
							connectedApp: bridge.getStatus().client?.app ?? null,
							details: { code: err?.code, message: err?.message, data: err?.data },
						});
					}
					throw err;
				}

				const rawItems = Array.isArray(res?.items) ? res.items : [];
				const items = rawItems
					.map((it: any) => {
						const rec = asRecord(it) ?? {};
						const deviceUuid =
							pickString(rec, ['uuid', 'deviceUuid', 'device_uuid', 'id']) ?? (typeof (it as any)?.uuid === 'string' ? String((it as any).uuid) : '');
						const libraryUuid = pickString(rec, ['libraryUuid', 'library_uuid']) ?? input.libraryUuid;
						const name = pickString(rec, ['name', 'title', 'deviceName', 'displayName']) ?? pickString(rec, ['key']) ?? '';
						const manufacturer = pickString(rec, ['manufacturer', 'Manufacturer']);
						const mpn = extractMpn(it);
						const lcsc = extractLcsc(it);
						const datasheetUrl = extractDatasheetUrl(it);
						const footprintName = pickString(rec, ['footprintName', 'package', 'footprint', 'FootprintName', 'Supplier Footprint']);
						const summary = pickString(rec, ['description', 'summary', 'desc']);

						return {
							deviceUuid,
							libraryUuid,
							name,
							manufacturer,
							mpn,
							lcsc,
							footprintName,
							datasheetUrl,
							summary,
							raw: input.detail === 'full' || input.includeRaw ? it : undefined,
						};
					})
					.filter((it: any) => Boolean(it.deviceUuid) && (input.requireDatasheet ? Boolean(it.datasheetUrl) : true));

				return asJsonText({
					ok: true,
					source: input.source,
					query: input.query,
					page: input.page,
					limit: input.limit,
					total: items.length,
					items,
				});
			},
		},
		{
			name: 'jlc.parts.pick',
			description: 'Pick/Rank candidate parts for selection (simple rules; returns reasons + datasheetUrl when available).',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					fromComponent: {
						type: 'object',
						properties: {
							value: { type: 'string' },
							footprintName: { type: 'string' },
							manufacturer: { type: 'string' },
							mpn: { type: 'string' },
							lcsc: { type: 'string' },
						},
						additionalProperties: false,
					},
					source: { type: 'string', enum: ['eda'] },
					libraryUuid: { type: 'string' },
					page: { type: 'number' },
					searchLimit: { type: 'number' },
					limit: { type: 'number' },
					requireDatasheet: { type: 'boolean' },
					constraints: {
						type: 'object',
						properties: {
							footprintName: { type: 'string' },
							requireFootprintMatch: { type: 'boolean' },
							manufacturer: { type: 'string' },
							requireManufacturerMatch: { type: 'boolean' },
						},
						additionalProperties: false,
					},
					detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
					includeRaw: { type: 'boolean' },
				},
				additionalProperties: false,
			},
			run: async (args) => {
				const input = PartsPickSchema.parse(args);
				if (input.source !== 'eda') {
					return asJsonText({ ok: false, error: `Unsupported source: ${input.source}` });
				}

				const fc = input.fromComponent;
				const inferredQuery =
					input.query ??
					[
						fc?.lcsc?.trim(),
						fc?.mpn?.trim(),
						fc?.manufacturer?.trim(),
						fc?.value?.trim(),
						fc?.footprintName?.trim(),
					]
						.filter(Boolean)
						.join(' ')
						.trim();
				if (!inferredQuery) return asJsonText({ ok: false, error: 'Missing query/fromComponent.' });

				const constraints = input.constraints;
				const wantFootprint = constraints?.footprintName ?? fc?.footprintName;
				const wantManufacturer = constraints?.manufacturer ?? fc?.manufacturer;

				let res: any;
				try {
					res = (await bridge.call(
						'library.searchDevices',
						{ key: inferredQuery, libraryUuid: input.libraryUuid, page: input.page, limit: input.searchLimit },
						60_000,
					)) as any;
				} catch (err: any) {
					if (err?.code === 'NOT_SUPPORTED') {
						return asJsonText({
							ok: false,
							error: 'EDA extension is too old (missing method library.searchDevices). Please install the latest .eext bridge extension.',
							connectedApp: bridge.getStatus().client?.app ?? null,
							details: { code: err?.code, message: err?.message, data: err?.data },
						});
					}
					throw err;
				}
				const rawItems = Array.isArray(res?.items) ? res.items : [];

				const candidates = rawItems
					.map((it: any) => {
						const rec = asRecord(it) ?? {};
						const deviceUuid =
							pickString(rec, ['uuid', 'deviceUuid', 'device_uuid', 'id']) ?? (typeof (it as any)?.uuid === 'string' ? String((it as any).uuid) : '');
						const libraryUuid = pickString(rec, ['libraryUuid', 'library_uuid']) ?? input.libraryUuid;
						const name = pickString(rec, ['name', 'title', 'deviceName', 'displayName']) ?? pickString(rec, ['key']) ?? '';
						const manufacturer = pickString(rec, ['manufacturer', 'Manufacturer']);
						const mpn = extractMpn(it);
						const lcsc = extractLcsc(it);
						const datasheetUrl = extractDatasheetUrl(it);
						const footprintName = pickString(rec, ['footprintName', 'package', 'footprint', 'FootprintName', 'Supplier Footprint']);
						const summary = pickString(rec, ['description', 'summary', 'desc']);

						return {
							deviceUuid,
							libraryUuid,
							name,
							manufacturer,
							mpn,
							lcsc,
							footprintName,
							datasheetUrl,
							summary,
							raw: input.detail === 'full' || input.includeRaw ? it : undefined,
						};
					})
					.filter((it: any) => Boolean(it.deviceUuid))
					.filter((it: any) => (input.requireDatasheet ? Boolean(it.datasheetUrl) : true))
					.filter((it: any) => {
						if (!wantFootprint || !constraints?.requireFootprintMatch) return true;
						return typeof it.footprintName === 'string' && it.footprintName.trim().toLowerCase() === wantFootprint.trim().toLowerCase();
					})
					.filter((it: any) => {
						if (!wantManufacturer || !constraints?.requireManufacturerMatch) return true;
						return typeof it.manufacturer === 'string' && it.manufacturer.trim().toLowerCase() === wantManufacturer.trim().toLowerCase();
					});

				const scored = candidates.map((it: any) => {
					const reasons: Array<string> = [];
					let score = 0;

					if (it.datasheetUrl) {
						score += 30;
						reasons.push('has datasheetUrl');
					}
					if (it.lcsc) {
						score += 20;
						reasons.push('has LCSC/supplier part number');
					}
					if (it.mpn) {
						score += 10;
						reasons.push('has MPN');
					}
					if (it.manufacturer) {
						score += 5;
						reasons.push('has manufacturer');
					}

					if (wantFootprint && typeof it.footprintName === 'string' && it.footprintName.trim()) {
						if (it.footprintName.trim().toLowerCase() === wantFootprint.trim().toLowerCase()) {
							score += 50;
							reasons.push(`footprint match: ${wantFootprint}`);
						}
					}
					if (wantManufacturer && typeof it.manufacturer === 'string' && it.manufacturer.trim()) {
						if (it.manufacturer.trim().toLowerCase() === wantManufacturer.trim().toLowerCase()) {
							score += 15;
							reasons.push(`manufacturer match: ${wantManufacturer}`);
						}
					}

					return { score, reasons, item: it };
				});

				scored.sort((a: any, b: any) => b.score - a.score);

				return asJsonText({
					ok: true,
					source: input.source,
					query: inferredQuery,
					constraints: {
						footprintName: wantFootprint,
						manufacturer: wantManufacturer,
						requireFootprintMatch: constraints?.requireFootprintMatch ?? false,
						requireManufacturerMatch: constraints?.requireManufacturerMatch ?? false,
						requireDatasheet: input.requireDatasheet,
					},
					totalCandidates: candidates.length,
					picks: scored.slice(0, input.limit),
				});
			},
		},
		{
			name: 'jlc.parts.get_datasheet',
			description: 'Resolve a datasheet URL (and optional PDF download) for a part/device.',
			inputSchema: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					deviceUuid: { type: 'string' },
					libraryUuid: { type: 'string' },
					download: { type: 'boolean' },
					savePath: { type: 'string' },
					fileName: { type: 'string' },
					force: { type: 'boolean' },
					includeFile: { type: 'boolean' },
					includeRawDevice: { type: 'boolean' },
					maxCharsFile: { type: 'number' },
				},
				additionalProperties: false,
			},
			run: async (args) => {
				const input = DatasheetSchema.parse(args);

				let datasheetUrl = input.url;
				let deviceRaw: any | undefined;
				let device: any | undefined;
				if (!datasheetUrl && input.deviceUuid) {
					try {
						deviceRaw = await bridge.call('library.getDevice', { deviceUuid: input.deviceUuid, libraryUuid: input.libraryUuid }, 60_000);
					} catch (err: any) {
						if (err?.code === 'NOT_SUPPORTED') {
							return asJsonText({
								ok: false,
								error: 'EDA extension is too old (missing method library.getDevice). Please install the latest .eext bridge extension.',
								connectedApp: bridge.getStatus().client?.app ?? null,
								details: { code: err?.code, message: err?.message, data: err?.data },
							});
						}
						throw err;
					}
					datasheetUrl = extractDatasheetUrl(deviceRaw);
					device = summarizeDevice(deviceRaw, { deviceUuid: input.deviceUuid, libraryUuid: input.libraryUuid });
				}
				if (!datasheetUrl) return asJsonText({ ok: false, error: 'No datasheet URL provided/found.' });

				let pdfUrl: string | undefined;
				if (/\.pdf(\?.*)?$/i.test(datasheetUrl)) {
					pdfUrl = datasheetUrl;
				} else {
					try {
						const resp = await fetch(datasheetUrl, {
							headers: {
								'user-agent':
									'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
								accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
								referer: datasheetUrl,
							},
						});
						if (resp.ok) {
							const html = await resp.text();
							pdfUrl = resolvePdfUrlFromHtml(html, datasheetUrl);
						}
					} catch {
						// ignore; we still return the original URL
					}
				}

				let downloaded: any | undefined;
				if (input.download) {
					const downloadUrl = pdfUrl ?? (/\.(pdf)(\?.*)?$/i.test(datasheetUrl) ? datasheetUrl : undefined);
					if (!downloadUrl) {
						downloaded = { ok: false, error: 'No PDF URL resolved; set download=false or provide a direct PDF URL.' };
					} else {
						const resp = await fetch(downloadUrl, {
							headers: {
								'user-agent':
									'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
								accept: 'application/pdf,*/*',
								referer: datasheetUrl,
							},
						});
						if (!resp.ok) {
							downloaded = { ok: false, error: `Download failed: HTTP ${resp.status}` };
						} else {
							const buf = new Uint8Array(await resp.arrayBuffer());
							const defaultName = (() => {
								try {
									const u = new URL(downloadUrl);
									const base = u.pathname.split('/').filter(Boolean).pop() ?? `datasheet_${getTimestampForFileName()}.pdf`;
									return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
								} catch {
									return `datasheet_${getTimestampForFileName()}.pdf`;
								}
							})();
							const fileName = safeFileName(input.fileName ?? defaultName);
							const savedTo = await writeBinaryFile({ savePath: input.savePath, fileName, force: input.force, data: buf });
							const file = input.includeFile ? await readFileSmart(savedTo, input.maxCharsFile) : undefined;
							downloaded = { ok: true, savedTo, fileName, totalBytes: buf.length, file };
						}
					}
				}

				return asJsonText({
					ok: true,
					datasheetUrl,
					pdfUrl,
					device,
					deviceRaw: input.includeRawDevice ? deviceRaw : undefined,
					downloaded,
				});
			},
		},
	];
}
