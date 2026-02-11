export type EventMap = {
  paired: { relay: string; wallet: string }
  connecting: { relay: string }
  connected: { room: string }
  request_sent: { request_id: string }
  response: { request_id: string; status: 'approved' | 'rejected'; tx_hash?: string }
  error: { message: string }
  disconnected: {}
}

type Handler<T> = (data: T) => void

export class TypedEmitter {
  private _listeners = new Map<keyof EventMap, Set<Handler<any>>>()

  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): this {
    let set = this._listeners.get(event)
    if (!set) {
      set = new Set()
      this._listeners.set(event, set)
    }
    set.add(handler)
    return this
  }

  off<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): this {
    this._listeners.get(event)?.delete(handler)
    return this
  }

  protected emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this._listeners.get(event)?.forEach((h) => h(data))
  }
}
