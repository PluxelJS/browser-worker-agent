import { newMessagePortRpcSession, type RpcStub } from 'capnweb'

/** A host-owned capability reference borrowed for one execution. */
export interface ApiLease {
	api: RpcStub<any>
	/** Releases the host's lease, never the host's shared session. */
	release(): void
}

/**
 * A MessagePort session owns its localMain. Always give it a duplicate, since
 * disposing a host's main session stub would close the shared connection.
 */
export function exposeApi(port: MessagePort, api: RpcStub<any>): Disposable {
	const exportedApi = api.dup()
	try {
		const bridge = newMessagePortRpcSession(port, exportedApi)
		let released = false
		return {
			[Symbol.dispose]() {
				if (released) return
				released = true
				bridge[Symbol.dispose]()
			},
		}
	} catch (error) {
		exportedApi[Symbol.dispose]()
		port.close()
		throw error
	}
}

export function acquireWorkerApi(port: MessagePort): RpcStub<any> {
	return newMessagePortRpcSession<any>(port)
}
