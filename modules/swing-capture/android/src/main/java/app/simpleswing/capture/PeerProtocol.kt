package app.simpleswing.capture

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import org.json.JSONObject

/**
 * Messages between a main phone and a second "camera" phone (see PeerLink). Keep in step with
 * ios/PeerProtocol.swift and scripts/multicam-peer.py.
 *
 * Wire format: `u8 type | u32 big-endian length | payload`. Payloads are UTF-8 JSON except DATA,
 * which is raw clip bytes. Times are capture-clock microseconds of the phone that receives them
 * (the main phone converts before sending), so the camera phone never needs the clock offset.
 *
 *   both   → HELLO   {v, role, name, platform, fps, view}
 *   main   → PING    {t1, syncUs?}                camera → PONG {t1, t2, t3}
 *   both   → STATE   {state}                      engine state; the camera follows armed/standby
 *   main   → TRIGGER {id, startUs, endUs, anchorUs}
 *   camera → REJECT  {id, reason}
 *   camera → CLIP    {id, fps, durationMs, anchorOffsetMs, size}, then DATA… and DONE {id}
 *   both   → BYE     {}
 */
sealed class PeerMessage {
  data class Hello(
    val version: Int,
    val role: String,
    val name: String,
    val platform: String,
    val fps: Int,
    /** The camera's angle on the golfer: "dtl" or "faceOn" ("" from the main phone). */
    val view: String,
  ) : PeerMessage()

  /** [syncUs] is the main phone's current sync uncertainty, so the camera phone can show it too. */
  data class Ping(val t1: Long, val syncUs: Long? = null) : PeerMessage()

  data class Pong(val t1: Long, val t2: Long, val t3: Long) : PeerMessage()

  data class State(val state: String) : PeerMessage()

  /** Save [startUs]..[endUs]; [anchorUs] is the impact (or button press) both clips are aligned on. */
  data class Trigger(val id: String, val startUs: Long, val endUs: Long, val anchorUs: Long) : PeerMessage()

  data class Reject(val id: String, val reason: String) : PeerMessage()

  data class Clip(
    val id: String,
    val fps: Int,
    val durationMs: Double,
    /** Where the anchor instant falls in the clip (may lie outside it). */
    val anchorOffsetMs: Double,
    val size: Long,
  ) : PeerMessage()

  class Data(val bytes: ByteArray, val length: Int = bytes.size) : PeerMessage()

  data class Done(val id: String) : PeerMessage()

  data object Bye : PeerMessage()

  /** A message type from a newer app version; ignored. */
  data class Unknown(val type: Int) : PeerMessage()
}

object PeerProtocol {
  const val VERSION = 1
  const val SERVICE_TYPE = "_simpleswing._tcp."
  const val DEFAULT_PORT = 47800
  const val CHUNK_BYTES = 64 * 1024
  /** Control payloads are tiny and DATA is at most one chunk; anything bigger is a corrupt stream. */
  private const val MAX_PAYLOAD = 1 shl 20

  private const val HELLO = 1
  private const val PING = 2
  private const val PONG = 3
  private const val STATE = 4
  private const val TRIGGER = 5
  private const val REJECT = 6
  private const val CLIP = 7
  private const val DATA = 8
  private const val DONE = 9
  private const val BYE = 10

  /** Writes one frame. Callers serialise writers on the stream. */
  fun write(out: DataOutputStream, message: PeerMessage) {
    if (message is PeerMessage.Data) {
      out.writeByte(DATA)
      out.writeInt(message.length)
      out.write(message.bytes, 0, message.length)
    } else {
      val (type, json) = encode(message)
      val payload = json.toString().toByteArray(Charsets.UTF_8)
      out.writeByte(type)
      out.writeInt(payload.size)
      out.write(payload)
    }
    out.flush()
  }

  /** Reads one frame; null at a clean end of stream. */
  fun read(input: DataInputStream): PeerMessage? {
    val type = try {
      input.readUnsignedByte()
    } catch (_: EOFException) {
      return null
    }
    val length = input.readInt()
    if (length < 0 || length > MAX_PAYLOAD) throw java.io.IOException("Bad frame length $length")
    val payload = ByteArray(length)
    input.readFully(payload)
    if (type == DATA) return PeerMessage.Data(payload)
    return decode(type, JSONObject(String(payload, Charsets.UTF_8)))
  }

  fun encode(message: PeerMessage): Pair<Int, JSONObject> {
    val j = JSONObject()
    val type = when (message) {
      is PeerMessage.Hello -> {
        j.put("v", message.version).put("role", message.role).put("name", message.name)
          .put("platform", message.platform).put("fps", message.fps).put("view", message.view)
        HELLO
      }
      is PeerMessage.Ping -> {
        j.put("t1", message.t1)
        message.syncUs?.let { j.put("syncUs", it) }
        PING
      }
      is PeerMessage.Pong -> {
        j.put("t1", message.t1).put("t2", message.t2).put("t3", message.t3)
        PONG
      }
      is PeerMessage.State -> {
        j.put("state", message.state)
        STATE
      }
      is PeerMessage.Trigger -> {
        j.put("id", message.id).put("startUs", message.startUs).put("endUs", message.endUs).put("anchorUs", message.anchorUs)
        TRIGGER
      }
      is PeerMessage.Reject -> {
        j.put("id", message.id).put("reason", message.reason)
        REJECT
      }
      is PeerMessage.Clip -> {
        j.put("id", message.id).put("fps", message.fps).put("durationMs", message.durationMs)
          .put("anchorOffsetMs", message.anchorOffsetMs).put("size", message.size)
        CLIP
      }
      is PeerMessage.Done -> {
        j.put("id", message.id)
        DONE
      }
      PeerMessage.Bye -> BYE
      is PeerMessage.Data, is PeerMessage.Unknown -> throw IllegalArgumentException("Not a JSON message: $message")
    }
    return type to j
  }

  fun decode(type: Int, j: JSONObject): PeerMessage = when (type) {
    HELLO -> PeerMessage.Hello(
      j.getInt("v"), j.getString("role"), j.optString("name"), j.optString("platform"), j.optInt("fps"), j.optString("view"),
    )
    PING -> PeerMessage.Ping(j.getLong("t1"), if (j.has("syncUs")) j.getLong("syncUs") else null)
    PONG -> PeerMessage.Pong(j.getLong("t1"), j.getLong("t2"), j.getLong("t3"))
    STATE -> PeerMessage.State(j.getString("state"))
    TRIGGER -> PeerMessage.Trigger(j.getString("id"), j.getLong("startUs"), j.getLong("endUs"), j.getLong("anchorUs"))
    REJECT -> PeerMessage.Reject(j.getString("id"), j.optString("reason"))
    CLIP -> PeerMessage.Clip(
      j.getString("id"), j.getInt("fps"), j.getDouble("durationMs"), j.getDouble("anchorOffsetMs"), j.getLong("size"),
    )
    DONE -> PeerMessage.Done(j.getString("id"))
    BYE -> PeerMessage.Bye
    else -> PeerMessage.Unknown(type)
  }
}
