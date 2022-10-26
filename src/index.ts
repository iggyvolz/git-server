import {Router} from 'itty-router'
import pako from 'pako';
// import * as zlib from 'zlib';

// now let's create a router (note the lack of "new")
const router = Router({
	base: "/:owner/:repo"
})

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const FlushPacket = 0;
const DelimeterPacket = 1;
const ResponseEndPacket = 2;
type SpecialPacket = typeof FlushPacket | typeof DelimeterPacket | typeof ResponseEndPacket;

function pktLine(lines: (string|SpecialPacket)[]): string {
	return lines.map(line => (typeof line === "string") ? (line.length+5).toString(16).padStart(4,"0") + line + "\n" : line.toString(16).padStart(4, "0")).join("")
}

function parsePktLines(buf: ArrayBuffer): (string|ArrayBuffer|SpecialPacket)[] {
	const packets: (string|ArrayBuffer|SpecialPacket)[] = [];
	let idx = 0;
	const read = (n:number) => {
		idx += n;
		return buf.slice(idx-n, idx);
	}
	while(idx < buf.byteLength) {
		// Read length
		const lengthString = read(4);
		if(decoder.decode(lengthString) === "PACK") {
			packets.push(buf.slice(idx));
			break;
		}
		const length = parseInt(decoder.decode(lengthString), 16);
		if(length === FlushPacket || length === DelimeterPacket || length === ResponseEndPacket) {
			packets.push(length);
			continue;
		}
		if(length === 3) {
			throw "Unknown packet type 0x3";
		}
		packets.push(decoder.decode(read(length-5)));
		read(1); // \n
	}
	return packets;
}
interface Environment
{
	kv: KVNamespace
}


async function kvGetAll(prefix: string, kv: KVNamespace): Promise<Map<string,string>> {
	const result: Map<string,string> = new Map;
	let list: KVNamespaceListResult<unknown>;
	let cursor: string|undefined = undefined;
	do {
		list = await kv.list({prefix, cursor});
		cursor = list.cursor;
		for (const key of list.keys.map(x => x.name)) {
			const value = await kv.get(key);
			if(value) {
				result.set(key, value);
			}
		}
	} while(!list.list_complete);
	return result;
}
router.get('/info/refs', async (request, env: Environment) => {
	const owner: string = request.params?.owner as string;
	const repo: string = request.params?.repo as string;
	const service = request?.query?.service
	if(service === "git-upload-pack") {
		return new Response(pktLine([
			`# service=${service}`,
			FlushPacket,
			"version 2",
			"ls-refs",
			"fetch",
			FlushPacket,
		]), {
			headers: {
				"Content-Type": `application/x-${service}-advertisement`,
				"Cache-Control": "no-cache",
			}
		})
	} else if(service === "git-receive-pack") {
		const branches = Array.from((await kvGetAll(`${owner}/${repo}/refs/heads/`, env.kv)).entries());
		const capabilities: string[] = [];
		return new Response(pktLine([
			`# service=${service}`,
			FlushPacket,
			(branches.length === 0 ? "0000000000000000000000000000000000000000 capabilities^{}" : branches[0].join(" ")) + "\0" + capabilities.join(" "),
			...(branches.slice(1)).map(x => x.join(" ")),
			FlushPacket,
		]), {
			headers: {
				"Content-Type": `application/x-${service}-advertisement`,
				"Cache-Control": "no-cache",
			}
		})
	} else {
		return new Response("Legacy protocol not allowed", {status: 403});
	}
})

router.post("/git-upload-pack", async (request, env: Environment) => {
	const owner: string = request.params?.owner as string;
	const repo: string = request.params?.repo as string;
	// @ts-ignore
	const body = parsePktLines(await request.text()); // TODO make cloudflare stop yelling here
	// First line: command={command}
	if(body[0] === "command=ls-refs" && body[1] === DelimeterPacket || body[body.length - 1] === FlushPacket) {
		const args = body.slice(2, -1).filter(x => typeof x === "string");
		let response: (SpecialPacket|string)[] = [];
		let peel: boolean = false;
		let symrefs: boolean = false;
		for (const arg of args) {
			if(arg === "peel") {
				peel = true;
			} else if(arg === "symrefs") {
				symrefs = true;
			} else if(typeof arg === "string" && arg.startsWith("ref-prefix ")) {
				const prefix = arg.substring("ref-prefix ".length)
				for(const [k, v] of await kvGetAll(`${owner}/${repo}/${prefix}`, env.kv)) {
					response.push(`${v} ${k}`);
				}
			} else {
				throw "Unknown argument"
			}
		}
		response.push(FlushPacket)
		return new Response(pktLine(response), {
			headers: {
				"Content-Type": "application/x-git-upload-pack-result",
				"Cache-Control": "no-cache",
			}
		})
	}
	return new Response("", {
		headers: {
			"Content-Type": "application/x-git-upload-pack-result",
			"Cache-Control": "no-cache",
		},
		status: 404
	})
})
const OBJ_COMMIT=1;
const OBJ_TREE=2;
const OBJ_BLOB=3;
const OBJ_TAG=4;
const OBJ_OFS_DELTA=6;
const OBJ_REF_DELTA=7;
type OBJECT_TYPE = typeof OBJ_COMMIT | typeof OBJ_TREE | typeof OBJ_BLOB | typeof OBJ_TAG;
const TYPE_NAME_MAP: Map<OBJECT_TYPE, string> = new Map([
	[OBJ_COMMIT, "commit"],
	[OBJ_TREE, "tree"],
	[OBJ_BLOB, "blob"],
	[OBJ_TAG, "tag"]
])
type DELTA_TYPE = typeof OBJ_OFS_DELTA | typeof OBJ_REF_DELTA;
type OBJECT_OR_DELTA_TYPE = OBJECT_TYPE | DELTA_TYPE;

function buf2hex(buffer: ArrayBuffer) { // buffer is an ArrayBuffer
	return [...new Uint8Array(buffer)]
		.map(x => x.toString(16).padStart(2, '0'))
		.join('');
}

function buf2base64(buffer: ArrayBuffer) {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}
//https://git-scm.com/docs/pack-format
async function unpack(buf: Uint8Array): Promise<Map<string, ArrayBuffer>> {
	// console.log(buf2hex(buf));
	const objs: Map<string, ArrayBuffer> = new Map();
	// console.log({buf})

	let idx = 0;
	const readByte = () => {
		if (idx >= buf.byteLength) {
			throw "tried to read beyond end";
		}
		return buf[idx++]
	};
	const readInt = () => {
		// TODO there's probably a better way to do this - since it's network byte order ugh
		let n: number = 0;
		for (let i = 0; i < 4; i++) {
			n <<= 4;
			n |= readByte();
		}
		return n;
	}
	const version = readInt();
	if (version !== 2) throw `Unknown version ${version}`
	// console.log({version})
	const numObjects = readInt();
	// console.log({numObjects});
	for (let i = 0; i < numObjects; i++) {
		// console.log(`${idx}/${buf.length}`)
		// console.log(buf[idx].toString(16))
		// console.log(buf[idx+1].toString(16))
		// console.log(buf[idx+2].toString(16))
		// console.log(buf[idx+3])
		let byte: number = readByte();
		// console.log(byte.toString(2))
		const _type: OBJECT_OR_DELTA_TYPE | 0 | 5 = (byte & 0b0111_0000) >> 4 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
		// Bits 2-4 are the type
		if (_type === 0 || _type === 5) throw `Unknown type ${_type}`;
		if(_type === OBJ_OFS_DELTA || _type === OBJ_REF_DELTA) throw `TODO: type ${_type}`;
		const type: OBJECT_TYPE = _type;
		const typeName: string = TYPE_NAME_MAP.get(type) as string;
		while(byte & 0b1000_0000) {
			byte = readByte();
		}
		const inflator = new pako.Inflate();
		let result: boolean;
		do {
			// console.log(`${idx}/${buf.length}`)
			result = inflator.push(buf.slice(idx, idx+1));
			idx++;
		} while(result);
		idx--;

		// Git object files have <type> <size>\0 preceeding them
		const prefix = encoder.encode(`${typeName} ${inflator.result.length.toString()}\0`);
		const conts = new Uint8Array(new ArrayBuffer(prefix.length + inflator.result.length));
		conts.set(prefix, 0);
		conts.set(inflator.result as Uint8Array, prefix.length);


		const hash = buf2hex(await crypto.subtle.digest(
			{
				name: 'SHA-1',
			},
			conts // The data you want to hash as an ArrayBuffer
		));
		// console.log({hash})
		// console.log(decoder.decode(conts as Uint8Array))
		objs.set(hash, conts)
		// objs.set(i.toString(), buf2base64(pako.inflateRaw(conts.buffer)))
	}
	return objs;
}

router.post("/git-receive-pack", async (request, env: Environment) => {
	const owner: string = request.params?.owner as string;
	const repo: string = request.params?.repo as string;
	// @ts-ignore
	const blob: Blob = await request.blob();
	const body = parsePktLines(await blob.arrayBuffer()); // TODO make cloudflare stop yelling here
	const pack = await unpack(new Uint8Array(body[2] as ArrayBuffer)); // TODO genericize
	console.log(pack)
	return new Response(pktLine([]), {
		headers: {
			"Content-Type": "application/x-git-upload-pack-result",
			"Cache-Control": "no-cache",
		}
	})
})

// 404 for everything else
router.all('*', (request) => {
	console.log(request.url)
	return new Response('Not Found.', { status: 404 })
})

const errorHandler = (error: { message?: any; status?: any; }) =>{
	console.error(error)
	return 	new Response(error.message || 'Server Error', { status: error.status || 500 });
}

export default {
// @ts-ignore
	fetch: (...args: any[]) => router.handle(...args).catch(errorHandler)
}