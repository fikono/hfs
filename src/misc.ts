// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { basename } from 'path'
import Koa from 'koa'
import { Connection } from './connections'
import assert from 'assert'
export * from './util-http'
export * from './util-files'
export * from './fileAttr'
export * from './cross'
export * from './debounceAsync'
import { Readable, Transform } from 'stream'
import { SocketAddress, BlockList } from 'node:net'
import { ApiError } from './apiMiddleware'
import { HTTP_BAD_REQUEST, HTTP_METHOD_NOT_ALLOWED } from './const'
import { isIpLocalHost, makeMatcher, try_ } from './cross'
import { isIPv6 } from 'net'
import { statusCodeForMissingPerm, VfsNode } from './vfs'
import events from './events'
import { rm } from 'fs/promises'
import { setCommentFor } from './comments'
import _ from 'lodash'

export function pattern2filter(pattern: string){
    const matcher = makeMatcher(pattern.includes('*') ? pattern  // if you specify *, we'll respect its position
        : pattern.split('|').map(x => `*${x}*`).join('|'))
    return (s: string) =>
        !pattern || matcher(basename(s||''))
}

export function isLocalHost(c: Connection | Koa.Context | string) {
    const ip = typeof c === 'string' ? c : c.socket.remoteAddress // don't use Context.ip as it is subject to proxied ips, and that's no use for localhost detection
    return ip && isIpLocalHost(ip)
}

// this will memory-leak over mask, so be careful with what you use this. Object is 3x faster than _.memoize
export function netMatches(ip: string, mask: string, emptyMaskReturns=false) {
    const cache = (netMatches as any).cache ||= {}
    return (cache[mask + (emptyMaskReturns ? '1' : '0')] ||= makeNetMatcher(mask, emptyMaskReturns))(ip) // cache the matcher
}
export function makeNetMatcher(mask: string, emptyMaskReturns=false) {
    if (!mask)
        return () => emptyMaskReturns
    mask = mask.replaceAll(' ','')
    mask = mask.replace('localhost', '::1|127.0.0.1')
    if (!mask.includes('/')) // for CIDR we use BlockList
        return makeMatcher(mask)
    const all = mask.split('|')
    const neg = all[0]?.[0] === '!'
    if (neg)
        all[0] = all[0]!.slice(1)
    const bl = new BlockList()
    for (const x of all) {
        const m = /^([.:\da-f]+)(?:\/(\d+)|-(.+)|)$/i.exec(x)
        if (!m) {
            console.warn("error in network mask", x)
            continue
        }
        const address = try_(() => parseAddress(m[1]!),
            () => console.error("invalid address " + m[1]))
        if (!address) continue
        if (m[2])
            try { bl.addSubnet(address, Number(m[2])) }
            catch { console.error("invalid net mask " + x) }
        else if (m[3])
            try { bl.addRange(address, parseAddress(m[2]!)) }
            catch { console.error("invalid address " + m[2]) }
        else
            bl.addAddress(address)
    }
    return (ip: string) => {
        try { return neg !== bl.check(parseAddress(ip)) }
        catch {
            console.error("invalid address ", ip)
            return false
        }
    }
}

// can throw ERR_INVALID_ADDRESS
function parseAddress(s: string) {
    return new SocketAddress({ address: s, family: isIPv6(s) ? 'ipv6' : 'ipv4' })
}

export function same(a: any, b: any) {
    return _.isEqual(a, b)
}

export function asyncGeneratorToReadable<T>(generator: AsyncIterable<T>) {
    const iterator = generator[Symbol.asyncIterator]()
    return new Readable({
        objectMode: true,
        destroy() {
            void iterator.return?.()
        },
        read() {
            iterator.next().then(it => {
                if (it.done)
                    this.emit('ending')
                return this.push(it.done ? null : it.value)
            })
        }
    })
}

// produces as promises resolve, not sequentially
export class AsapStream<T> extends Readable {
    finished = false
    constructor(private promises: Promise<T>[]) {
        super({ objectMode: true })
    }
    _read() {
        if (this.finished) return
        this.finished = true
        for (const p of this.promises)
            p.then(x => x !== undefined && this.push(x),
                e => this.emit('error', e) )
        Promise.allSettled(this.promises).then(() => this.push(null))
    }
}

export function apiAssertTypes(paramsByType: { [type:string]: { [name:string]: any  } }) {
    for (const [types,params] of Object.entries(paramsByType))
        for (const [name,val] of Object.entries(params))
            if (! types.split('_').some(type => type === 'array' ? Array.isArray(val) : typeof val === type))
                throw new ApiError(HTTP_BAD_REQUEST, 'bad ' + name)
}

export function createStreamLimiter(limit: number) {
    let got = 0
    return new Transform({
        transform(chunk, enc, done) {
            const left = limit - got
            got += chunk.length
            if (left > 0) {
                this.push(chunk.length >= left ? chunk.slice(0, left) : chunk)
                if (got >= limit)
                    this.end()
            }
            done()
        }
    })
}

export async function deleteNode(ctx: Koa.Context, node: VfsNode, uri: string): Promise<number | Error> {
    const { source } = node
    if (!source)
        return ctx.status = HTTP_METHOD_NOT_ALLOWED
    if (statusCodeForMissingPerm(node, 'can_delete', ctx))
        return ctx.status
    try {
        if ((await events.emitAsync('deleting', { node, ctx }))?.isDefaultPrevented())
            return 0 // stop
        const target = decodeURI(uri)
        if (target !== ctx.path) // only in case of api-call
            ctx.logExtra(null, { target })
        await rm(source, { recursive: true })
        void setCommentFor(source, '')
        return 0
    } catch (e: any) {
        return e
    }
}
