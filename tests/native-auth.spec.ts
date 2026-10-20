import { describe, expect, it, vi } from 'vitest'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { installNativeAuthBridge } from '../src/native-auth.js'

function fixture(nativeStatus: 401 | 403 | undefined, valid = true) {
  const requestRejection = vi.fn(() => nativeStatus)
  const authorizeIndex = vi.fn(() => false)
  const browserPeer = { id: 'browser', principal: { kind: 'owner' } }
  const nativePeer = { id: 'api', principal: { kind: 'owner' } }
  const admit = vi.fn(() => nativeStatus === undefined ? { peer: nativePeer } : { rejection: nativeStatus })
  const connection = { requestRejection, authorizeIndex, admit, browserPeer } as unknown as HostConnectionHandle
  const authenticated = vi.fn(() => valid)
  const dispose = installNativeAuthBridge(connection, authenticated)
  return { connection, requestRejection, authorizeIndex, authenticated, dispose, admit, browserPeer, nativePeer }
}

describe('explicit native operator bridge', () => {
  it('admits verified external sessions as the browser owner and restores admission', () => {
    const f = fixture(401)
    expect(f.connection.admit({ headers: { cookie: 'signed-session' } })).toEqual({ peer: f.browserPeer })
    expect(f.authenticated).toHaveBeenCalledWith('signed-session')
    f.dispose()
    expect(Object.getOwnPropertyDescriptor(f.connection, 'admit')?.value).toBe(f.admit)
  })
  it('preserves denied origins, revoked sessions and native API principals on admission', () => {
    const origin = fixture(403)
    expect(origin.connection.admit({ headers: {} })).toEqual({ rejection: 403 })
    expect(origin.authenticated).not.toHaveBeenCalled()
    const revoked = fixture(401, false)
    expect(revoked.connection.admit({ headers: {} })).toEqual({ rejection: 401 })
    const native = fixture(undefined)
    expect(native.connection.admit({ headers: {} })).toEqual({ peer: native.nativePeer })
    expect(native.authenticated).not.toHaveBeenCalled()
  })
  it.each([{ cookie: 'signed-session' }, new Headers({ Cookie: 'signed-session' })])('accepts a verified session with Node or Fetch headers', headers => {
    const f = fixture(401)
    expect(f.connection.requestRejection({ headers })).toBeUndefined()
    expect(f.authenticated).toHaveBeenCalledWith('signed-session')
  })
  it('preserves the native Host and Origin rejection even with a valid session', () => {
    const f = fixture(403)
    expect(f.connection.requestRejection({ headers: {} })).toBe(403)
    expect(f.authenticated).not.toHaveBeenCalled()
  })
  it('denies invalid or revoked sessions and preserves existing native authentication', () => {
    const denied = fixture(401, false)
    expect(denied.connection.requestRejection({ headers: {} })).toBe(401)
    const native = fixture(undefined, false)
    expect(native.connection.requestRejection({ headers: {} })).toBeUndefined()
    expect(native.authenticated).not.toHaveBeenCalled()
  })
  it('allows index before the native method can end the response', () => {
    const f = fixture(401)
    const request = { headers: {}, method: 'GET', url: '/' }
    expect(f.connection.authorizeIndex(request, {} as never)).toBe(true)
    expect(f.authorizeIndex).not.toHaveBeenCalled()
    f.dispose()
    expect(f.connection.authorizeIndex(request, {} as never)).toBe(false)
  })
  it('delegates rejected index requests and restores only its own wrappers', () => {
    const f = fixture(403)
    expect(f.connection.authorizeIndex({ headers: {} }, {} as never)).toBe(false)
    expect(f.authorizeIndex).toHaveBeenCalledOnce()
    const replacement = () => 401 as const
    f.connection.requestRejection = replacement
    f.dispose()
    expect(Object.getOwnPropertyDescriptor(f.connection, 'requestRejection')?.value).toBe(replacement)
    expect(Object.getOwnPropertyDescriptor(f.connection, 'authorizeIndex')?.value).toBe(f.authorizeIndex)
  })
})
