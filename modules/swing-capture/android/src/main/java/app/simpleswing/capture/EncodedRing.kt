package app.simpleswing.capture

/** One encoded access unit (video frame or AAC frame) copied out of a MediaCodec output buffer. */
class EncodedSample(val data: ByteArray, val ptsUs: Long, val isKeyFrame: Boolean)

/**
 * Thread-safe rolling window of encoded samples in decode order.
 *
 * The window always begins at a keyframe so any snapshot can be decoded on its own. Pruning drops
 * whole GOPs once the next keyframe is older than the window, so the retained span is between
 * [windowUs] and [windowUs] + one keyframe interval.
 */
class EncodedRing(private var windowUs: Long) {
  private val samples = ArrayDeque<EncodedSample>()

  @Synchronized
  fun setWindow(us: Long) {
    windowUs = us
  }

  @Synchronized
  fun add(sample: EncodedSample) {
    samples.addLast(sample)
    prune(sample.ptsUs - windowUs)
  }

  @Synchronized
  fun clear() = samples.clear()

  @Synchronized
  fun oldestPtsUs(): Long? = samples.firstOrNull()?.ptsUs

  /**
   * Samples covering [fromUs, toUs], starting at the last keyframe at or before [fromUs] (or the
   * oldest keyframe if the buffer doesn't reach back that far).
   */
  @Synchronized
  fun snapshot(fromUs: Long, toUs: Long): List<EncodedSample> {
    var start = -1
    for (i in samples.indices) {
      val s = samples[i]
      if (s.ptsUs > fromUs) break
      if (s.isKeyFrame) start = i
    }
    if (start < 0) start = samples.indexOfFirst { it.isKeyFrame }
    if (start < 0) return emptyList()
    val out = ArrayList<EncodedSample>()
    for (i in start until samples.size) {
      val s = samples[i]
      if (s.ptsUs > toUs) break
      out.add(s)
    }
    return out
  }

  private fun prune(cutoffUs: Long) {
    var keepFrom = -1
    for (i in samples.indices) {
      val s = samples[i]
      if (s.ptsUs > cutoffUs) break
      if (s.isKeyFrame) keepFrom = i
    }
    repeat(maxOf(keepFrom, 0)) { samples.removeFirst() }
  }
}
