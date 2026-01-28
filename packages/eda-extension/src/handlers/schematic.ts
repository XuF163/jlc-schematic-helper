import {
	asObject,
	asOptionalBoolean,
	asOptionalNumber,
	asOptionalString,
	endsWithPathSeparator,
	rpcError,
	safeFileName,
} from '../bridge/validate';

async function requireSchematicPage(): Promise<void> {
	const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!info) throw rpcError('NO_ACTIVE_DOCUMENT', 'No active document');
	if (info.documentType !== 1 /* SCHEMATIC_PAGE */) {
		throw rpcError('NOT_IN_SCHEMATIC_PAGE', 'Current document is not a schematic page');
	}
}

function getTimestampForFileName(): string {
	return safeFileName(new Date().toISOString());
}

function joinPath(folderOrFile: string, fileName: string): string {
	if (endsWithPathSeparator(folderOrFile)) return `${folderOrFile}${fileName}`;
	return folderOrFile;
}

async function readFileAsText(file: any): Promise<string> {
	// Prefer modern Blob/File helpers when available.
	try {
		if (file && typeof file.text === 'function') {
			return String(await file.text());
		}
	} catch {
		// ignore and try fallbacks
	}

	try {
		if (file && typeof file.arrayBuffer === 'function' && typeof (globalThis as any).TextDecoder === 'function') {
			const ab = await file.arrayBuffer();
			const u8 = new Uint8Array(ab);
			return new (globalThis as any).TextDecoder('utf-8').decode(u8);
		}
	} catch {
		// ignore and try FileReader fallback
	}

	// FileReader fallback (older environments).
	try {
		if (typeof (globalThis as any).FileReader === 'function') {
			const reader = new (globalThis as any).FileReader();
			return await new Promise<string>((resolve, reject) => {
				reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
				reader.onload = () => resolve(String(reader.result ?? ''));
				reader.readAsText(file);
			});
		}
	} catch {
		// ignore
	}

	const meta = {
		type: typeof file,
		tag: Object.prototype.toString.call(file),
		ctor: file?.constructor?.name,
		hasText: typeof file?.text === 'function',
		hasArrayBuffer: typeof file?.arrayBuffer === 'function',
		size: typeof file?.size === 'number' ? file.size : undefined,
		name: typeof file?.name === 'string' ? file.name : undefined,
	};
	throw rpcError('READ_FILE_FAILED', 'Unable to read netlist file content as text', meta);
}

// Export netlist in EasyEDA Pro format (commonly `.enet`).
export async function exportEnetFile(params: unknown): Promise<{
	savedTo?: string;
	fileName: string;
	netlistType: string;
	downloadTriggered?: boolean;
}> {
	await requireSchematicPage();

	const input = params ? asObject(params, 'params') : {};
	const savePath = asOptionalString(input.savePath, 'savePath');
	const fileNameInput = asOptionalString(input.fileName, 'fileName');
	const force = asOptionalBoolean(input.force, 'force') ?? true;

	const requestedNetlistType = asOptionalString(input.netlistType, 'netlistType');
	const desiredFileName = safeFileName(fileNameInput || `jlceda_schematic_helper_netlist_${getTimestampForFileName()}.enet`);

	const replaceExt = (name: string, ext: string): string => {
		if (name.toLowerCase().endsWith(ext.toLowerCase())) return name;
		// Replace last extension if present; otherwise append.
		const next = name.includes('.') ? name.replace(/\.[^.]+$/, ext) : `${name}${ext}`;
		return next;
	};

	const candidates: Array<{ netlistType: string; fileName: string }> = [];
	const prefer = requestedNetlistType?.trim() || 'EasyEDA';
	const altNet = replaceExt(desiredFileName, '.net');
	// Try: preferred type with desired name; then preferred type with .net; then JLCEDA fallbacks.
	candidates.push({ netlistType: prefer, fileName: desiredFileName });
	if (altNet !== desiredFileName) candidates.push({ netlistType: prefer, fileName: altNet });
	if (prefer !== 'JLCEDA') {
		candidates.push({ netlistType: 'JLCEDA', fileName: altNet });
		if (altNet !== desiredFileName) candidates.push({ netlistType: 'JLCEDA', fileName: desiredFileName });
	}

	let lastErr: unknown;
	let chosen: { netlistType: string; fileName: string } | undefined;
	let file: any | undefined;
	for (const c of candidates) {
		try {
			file = await eda.sch_ManufactureData.getNetlistFile(c.fileName, c.netlistType as any);
			if (file) {
				chosen = c;
				break;
			}
		} catch (err) {
			lastErr = err;
		}
	}
	if (!file || !chosen) {
		const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'Unknown error');
		throw rpcError('EXPORT_FAILED', `Failed to get netlist file: ${msg}`, { candidates, requestedNetlistType });
	}

	let resolvedSavePath = savePath;
	if (!resolvedSavePath) {
		try {
			const edaPath = await eda.sys_FileSystem.getEdaPath();
			resolvedSavePath = endsWithPathSeparator(edaPath) ? edaPath : `${edaPath}\\`;
		} catch {
			// fallback to saveFile below
		}
	}

	if (resolvedSavePath) {
		try {
			const ok = await eda.sys_FileSystem.saveFileToFileSystem(resolvedSavePath, file, chosen.fileName, force);
			if (!ok) throw rpcError('SAVE_FILE_FAILED', 'Failed to save enet/netlist file to file system', { resolvedSavePath, chosen });
			return { savedTo: joinPath(resolvedSavePath, chosen.fileName), fileName: chosen.fileName, netlistType: chosen.netlistType };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw rpcError('SAVE_FILE_FAILED', `Failed to save enet/netlist file to file system: ${msg}`, { resolvedSavePath, chosen });
		}
	}

	await eda.sys_FileSystem.saveFile(file, chosen.fileName);
	return { fileName: chosen.fileName, netlistType: chosen.netlistType, downloadTriggered: true };
}

export async function getNetlist(params: unknown): Promise<{
	netlistType: string;
	netlist: string;
	truncated: boolean;
	totalChars: number;
}> {
	await requireSchematicPage();

	const input = params ? asObject(params, 'params') : {};
	const requestedNetlistType = asOptionalString(input.netlistType, 'netlistType');
	const maxChars = asOptionalNumber(input.maxChars, 'maxChars');
	// Note: some EDA APIs may block the JS event loop; in such cases in-extension timeouts won't help.
	// We keep timeoutMs for API-based fallback, but default path uses getNetlistFile + readFileAsText.
	const timeoutMs = asOptionalNumber(input.timeoutMs, 'timeoutMs') ?? 30_000;
	const preferApi = asOptionalBoolean(input.preferApi, 'preferApi') ?? false;

	const fileNameInput = asOptionalString(input.fileName, 'fileName');
	const desiredFileName = safeFileName(fileNameInput || `jlceda_schematic_helper_netlist_${getTimestampForFileName()}.enet`);

	const replaceExt = (name: string, ext: string): string => {
		if (name.toLowerCase().endsWith(ext.toLowerCase())) return name;
		const next = name.includes('.') ? name.replace(/\.[^.]+$/, ext) : `${name}${ext}`;
		return next;
	};

	const candidates: Array<{ netlistType: string; fileName: string }> = [];
	const prefer = requestedNetlistType?.trim() || 'EasyEDA';
	const altNet = replaceExt(desiredFileName, '.net');
	candidates.push({ netlistType: prefer, fileName: desiredFileName });
	if (altNet !== desiredFileName) candidates.push({ netlistType: prefer, fileName: altNet });
	if (prefer !== 'JLCEDA') {
		candidates.push({ netlistType: 'JLCEDA', fileName: altNet });
		if (altNet !== desiredFileName) candidates.push({ netlistType: 'JLCEDA', fileName: desiredFileName });
	}

	// Default: prefer ManufactureData export + read back as text (avoids SYS_FileSystem permissions and is often more stable).
	if (!preferApi) {
		let lastErr: unknown;
		for (const c of candidates) {
			try {
				const file = await eda.sch_ManufactureData.getNetlistFile(c.fileName, c.netlistType as any);
				if (!file) continue;

				const netlist = await readFileAsText(file);
				const totalChars = netlist.length;
				if (maxChars && Number.isFinite(maxChars) && maxChars > 0 && totalChars > maxChars) {
					return { netlistType: c.netlistType, netlist: netlist.slice(0, Math.floor(maxChars)), truncated: true, totalChars };
				}

				return { netlistType: c.netlistType, netlist, truncated: false, totalChars };
			} catch (err) {
				lastErr = err;
			}
		}

		const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'Unknown error');
		throw rpcError('EXPORT_FAILED', `Failed to get netlist content from ManufactureData: ${msg}`, { candidates, requestedNetlistType });
	}

	// Fallback: SCH_Netlist.getNetlist() (may block in some versions/projects).
	const netlistApi = (eda as any)?.sch_Netlist;
	const getNetlistFn = netlistApi?.getNetlist;
	if (!netlistApi || typeof getNetlistFn !== 'function') {
		throw rpcError('NOT_SUPPORTED', 'eda.sch_Netlist.getNetlist is not available in this EDA version');
	}

	const netlist = String(
		await Promise.race([
			Promise.resolve().then(() => getNetlistFn.call(netlistApi, prefer as any)),
			new Promise((_, reject) =>
				setTimeout(() => reject(rpcError('TIMEOUT', `Timed out getting netlist after ${timeoutMs}ms`)), timeoutMs),
			),
		]),
	);
	const totalChars = netlist.length;

	if (maxChars && Number.isFinite(maxChars) && maxChars > 0 && totalChars > maxChars) {
		return { netlistType: prefer, netlist: netlist.slice(0, Math.floor(maxChars)), truncated: true, totalChars };
	}

	return { netlistType: prefer, netlist, truncated: false, totalChars };
}
