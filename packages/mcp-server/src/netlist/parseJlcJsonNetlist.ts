import type { NetlistEndpoint } from './parseNetlist.js';

export type JlcNetlistPin = {
	pin: string;
	net: string;
	name?: string;
};

export type JlcNetlistComponent = {
	ref: string;
	value?: string;
	footprintName?: string;
	lcsc?: string;
	manufacturer?: string;
	mpn?: string;
	datasheetUrl?: string;
	jlcpcbPartClass?: string;
	pins: Array<JlcNetlistPin>;
	// For `detail: full` consumers; may be omitted to keep payload small.
	props?: Record<string, string>;
};

export type ParsedJlcJsonNetlist = {
	ok: boolean;
	warnings: Array<string>;
	components: Array<JlcNetlistComponent>;
	nets: Record<string, Array<NetlistEndpoint>>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

function normalizeNetName(name: string): string {
	return String(name).trim().replace(/^"(.*)"$/, '$1').toUpperCase();
}

function normalizeRef(ref: string): string {
	return String(ref).trim().toUpperCase();
}

function normalizePin(pin: string): string {
	return String(pin).trim().toUpperCase();
}

// JLCEDA Pro (v3.2.84) can return a JSON netlist (version 2.0.0) that looks like:
// { version, components: { <id>: { props: {...}, pinInfoMap: { <pinId>: { number,name,net } } } }, ... }
export function parseJlcJsonNetlist(text: string): ParsedJlcJsonNetlist | undefined {
	const trimmed = String(text ?? '').trim();
	if (!trimmed.startsWith('{')) return undefined;

	let root: unknown;
	try {
		root = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	const rootObj = asRecord(root);
	if (!rootObj) return undefined;

	const componentsObj = asRecord(rootObj.components);
	if (!componentsObj) return undefined;

	const warnings: Array<string> = [];
	const components: Array<JlcNetlistComponent> = [];
	const netsByKey = new Map<string, { name: string; endpoints: Map<string, NetlistEndpoint> }>();

	const ensureNet = (name: string) => {
		const key = normalizeNetName(name);
		let entry = netsByKey.get(key);
		if (!entry) {
			entry = { name: String(name).trim(), endpoints: new Map() };
			netsByKey.set(key, entry);
		}
		return entry;
	};

	for (const [compId, compRaw] of Object.entries(componentsObj)) {
		const comp = asRecord(compRaw);
		if (!comp) continue;

		const propsRaw = asRecord(comp.props) ?? {};
		const pinInfoMap = asRecord(comp.pinInfoMap) ?? {};

		const designator =
			asString(propsRaw.Designator) ??
			asString((propsRaw as any).designator) ??
			(compId ? `U?_${compId}` : 'U?');

		const ref = normalizeRef(designator);
		const value = asString(propsRaw.Value) ?? asString(propsRaw.Name);
		const footprintName = asString(propsRaw.FootprintName) ?? asString(propsRaw['Supplier Footprint']);
		const lcsc = asString(propsRaw['Supplier Part']);
		const manufacturer = asString(propsRaw.Manufacturer);
		const mpn = asString(propsRaw['Manufacturer Part']) ?? asString(propsRaw.DeviceName);
		const datasheetUrl = asString(propsRaw.Datasheet);
		const jlcpcbPartClass = asString(propsRaw['JLCPCB Part Class']);

		const pins: Array<JlcNetlistPin> = [];
		for (const [pinId, pinRaw] of Object.entries(pinInfoMap)) {
			const pinObj = asRecord(pinRaw);
			if (!pinObj) continue;

			const net = asString(pinObj.net) ?? '';
			const number = asString(pinObj.number) ?? asString(pinObj['Pin Number']) ?? pinId;
			const name = asString(pinObj.name) ?? undefined;

			const pin = normalizePin(number);
			pins.push({ pin, net, name });

			if (!net.trim()) continue;
			const netEntry = ensureNet(net);
			const ep: NetlistEndpoint = { ref, pin };
			netEntry.endpoints.set(`${ep.ref}.${ep.pin}`, ep);
		}

		const props: Record<string, string> = {};
		for (const [k, v] of Object.entries(propsRaw)) {
			const s = asString(v);
			if (s !== undefined) props[String(k)] = s;
		}

		components.push({
			ref,
			value,
			footprintName,
			lcsc,
			manufacturer,
			mpn,
			datasheetUrl,
			jlcpcbPartClass,
			pins,
			props,
		});
	}

	const nets: Record<string, Array<NetlistEndpoint>> = {};
	let endpointCount = 0;
	for (const entry of netsByKey.values()) {
		const list = Array.from(entry.endpoints.values());
		nets[normalizeNetName(entry.name)] = list;
		endpointCount += list.length;
	}

	if (components.length === 0) warnings.push('No components parsed from JSON netlist.');
	if (Object.keys(nets).length === 0) warnings.push('No nets parsed from JSON netlist.');
	if (Object.keys(nets).length > 0 && endpointCount === 0) warnings.push('Nets were detected but no endpoints (Ref.Pin) could be parsed.');

	return { ok: warnings.length === 0, warnings, components, nets };
}
