/** Explicit single-operator integration with DSH 0.2's browser admission. */
import type { ConnectionTrustRequest, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

/** Bridge only installations whose authenticated users may act as the native operator. */
export function installNativeAuthBridge(
  connection: HostConnectionHandle,
  authenticated: (cookie: string | undefined) => boolean,
): () => void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original method identity; invoke it with call(connection).
  const originalRejection = connection.requestRejection
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original method identity; invoke it with call(connection).
  const originalAdmit = connection.admit
  const admit: typeof originalAdmit = request => {
    const result = originalAdmit.call(connection, request)
    // New HTTP and WebSocket carriers consume Peer admission directly. Keep
    // native API principals and the Host/Origin fence; only bridge a 401.
    return 'rejection' in result && result.rejection === 401 && authenticated(cookieFrom(request.headers))
      ? { peer: connection.browserPeer }
      : result
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original method identity; invoke it with call(connection).
  const originalIndex = connection.authorizeIndex
  const rejection: typeof originalRejection = request => {
    const result = originalRejection.call(connection, request)
    return result === 401 && authenticated(cookieFrom(request.headers)) ? undefined : result
  }
  const index: typeof originalIndex = (request, response) => {
    // authorizeIndex may end the response; check the unchanged fence before calling it.
    if (originalRejection.call(connection, request) !== 403 && authenticated(cookieFrom(request.headers))) return true
    return originalIndex.call(connection, request, response)
  }
  connection.admit = admit
  connection.requestRejection = rejection
  connection.authorizeIndex = index
  return () => {
    if (connection.admit === admit) connection.admit = originalAdmit
    if (connection.requestRejection === rejection) connection.requestRejection = originalRejection
    if (connection.authorizeIndex === index) connection.authorizeIndex = originalIndex
  }
}

function cookieFrom(headers: ConnectionTrustRequest['headers']): string | undefined {
  const value = headers instanceof Headers ? headers.get('cookie') : Object.entries(headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1]
  return typeof value === 'string' ? value : undefined
}
