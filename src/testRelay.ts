import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * minimal in-process relay: RFC 6455 text frames over node:http, `join` → `joined`,
 * `message` → broadcast `{ type, room, payload }` to the other members of the room.
 * keeps the suite self-contained (the real relay lives in a separate repo).
 * every raw client message is recorded in `received` for wire-format assertions.
 */
export interface TestRelay {
  url: string
  received: any[]
  close: () => Promise<void>
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  const len = payload.length
  const header = len < 126
    ? Buffer.from([0x81, len])
    : len < 65536
      ? Buffer.from([0x81, 126, len >> 8, len & 0xff])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
  return Buffer.concat([header, payload])
}

/** parse complete client frames from `buf`; returns [frames, leftover bytes] */
function decodeFrames(buf: Buffer): [{ opcode: number; data: Buffer }[], Buffer] {
  const frames: { opcode: number; data: Buffer }[] = []
  let off = 0
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f
    const masked = (buf[off + 1] & 0x80) !== 0
    let len = buf[off + 1] & 0x7f
    let pos = off + 2
    if (len === 126) {
      if (buf.length < pos + 2) break
      len = buf.readUInt16BE(pos)
      pos += 2
    } else if (len === 127) {
      if (buf.length < pos + 8) break
      len = Number(buf.readBigUInt64BE(pos))
      pos += 8
    }
    const maskLen = masked ? 4 : 0
    if (buf.length < pos + maskLen + len) break
    const data = Buffer.from(buf.subarray(pos + maskLen, pos + maskLen + len))
    if (masked) {
      for (let i = 0; i < data.length; i++) data[i] ^= buf[pos + (i % 4)]
    }
    frames.push({ opcode, data })
    off = pos + maskLen + len
  }
  return [frames, buf.subarray(off)]
}

export async function startTestRelay(): Promise<TestRelay> {
  const rooms = new Map<string, Set<Socket>>()
  const sockets = new Set<Socket>()
  const received: any[] = []

  const server: Server = createServer((_req, res) => { res.writeHead(426).end() })
  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) return socket.destroy()
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)
    let room: string | null = null
    let pending = Buffer.alloc(0)

    const leave = () => {
      sockets.delete(socket)
      if (room) rooms.get(room)?.delete(socket)
    }
    socket.on('close', leave)
    socket.on('error', leave)

    socket.on('data', (chunk: Buffer) => {
      const [frames, rest] = decodeFrames(Buffer.concat([pending, chunk]))
      pending = Buffer.from(rest)
      for (const { opcode, data } of frames) {
        if (opcode === 0x8) { socket.end(); return } // close
        if (opcode !== 0x1) continue // ignore non-text frames
        let msg: any
        try { msg = JSON.parse(data.toString()) } catch { continue }
        received.push(msg)
        if (msg.type === 'join' && typeof msg.room === 'string') {
          if (room) rooms.get(room)?.delete(socket)
          room = msg.room
          if (!rooms.has(msg.room)) rooms.set(msg.room, new Set())
          rooms.get(msg.room)!.add(socket)
          socket.write(encodeTextFrame(JSON.stringify({ type: 'joined', room: msg.room })))
        } else if (msg.type === 'message' && room && msg.room === room) {
          const out = encodeTextFrame(JSON.stringify({ type: 'message', room, payload: msg.payload }))
          for (const peer of rooms.get(room) ?? []) {
            if (peer !== socket && !peer.destroyed) peer.write(out)
          }
        }
      }
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    }),
  }
}
