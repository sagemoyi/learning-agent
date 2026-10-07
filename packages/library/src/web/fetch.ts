// Download one page or file found online. Addresses come from search results, so this only connects to
// public internet addresses: every DNS answer is checked and the connection uses the checked answer,
// redirects are checked again, and size and time are capped. Without these checks a search result
// could make this computer fetch from its own network (a router page, a local service).
//
// Fake-IP proxies (Clash, sing-box, Surge; common in China) answer every name with an address from
// 198.18.0.0/15 and connect by name. Those answers are let through, or nothing could be fetched behind
// such a proxy; where the proxy finally connects cannot be checked here (compatibility.md, 10-07).
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'

const NOT_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['2002::', 16]] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')

/** True only for a globally reachable unicast address; IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4')
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    return mapped ? isPublicAddress(mapped[1]!) : !NOT_PUBLIC.check(address, 'ipv6')
  }
  return false
}

export interface Downloaded {
  /** After redirects. */
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly body: Buffer
}

export interface DownloadOptions {
  readonly maxBytes: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Which resolved addresses may be connected to; tests pass their loopback server. */
  readonly allowAddress?: (address: string) => boolean
}

const MAX_REDIRECTS = 5
/** An honest agent string: the request comes from a learner's own study tool, not a disguised browser. */
const USER_AGENT = 'learning-agent/0.1 (personal study; +https://github.com/deepseek-ai)'

export class DownloadError extends Error {}

export async function download(url: string, options: DownloadOptions): Promise<Downloaded> {
  const allow = options.allowAddress ?? isPublicAddress
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  let current = new URL(url)
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new DownloadError('只能打开 http 和 https 网址')
    const literal = current.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !allow(literal)) throw new DownloadError('不访问本机或局域网地址')
    const response = await get(current, allow, signal)
    const location = response.headers.location
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume()
      if (hop >= MAX_REDIRECTS) throw new DownloadError(`跳转超过 ${MAX_REDIRECTS} 次`)
      current = new URL(location, current)
      continue
    }
    const body = await read(response, options.maxBytes, signal)
    return { url: current.toString(), status: response.statusCode ?? 0, contentType: String(response.headers['content-type'] ?? ''), body }
  }
}

function get(url: URL, allow: (address: string) => boolean, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Resolve once, refuse the whole answer if any address is not allowed, and connect to that answer.
    const lookup = (hostname: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, '')
        if (addresses.length === 0 || addresses.some(entry => !allow(entry.address))) return callback(new DownloadError('不访问本机或局域网地址'), '')
        if (lookupOptions.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      })
    }
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET',
      lookup: lookup as never,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
      signal,
    }, resolve)
    request.on('error', error => reject(signal.aborted ? new DownloadError(abortReason(signal)) : error))
    request.end()
  })
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? '网站响应太慢，已超时' : '已取消'
}

function read(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length'])
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
    if (!encoding && Number.isFinite(declared) && declared > maxBytes) {
      response.destroy()
      reject(new DownloadError(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`))
      return
    }
    const stream: Readable = encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'deflate' ? response.pipe(createInflate()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : response
    const parts: Buffer[] = []
    let total = 0
    const fail = (error: Error) => { response.destroy(); stream.destroy(); reject(error) }
    stream.on('data', (part: Buffer) => {
      total += part.length
      if (total > maxBytes) fail(new DownloadError(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`))
      else parts.push(part)
    })
    stream.on('end', () => resolve(Buffer.concat(parts)))
    stream.on('error', error => fail(signal.aborted ? new DownloadError(abortReason(signal)) : error))
    response.on('error', error => fail(signal.aborted ? new DownloadError(abortReason(signal)) : error))
  })
}
