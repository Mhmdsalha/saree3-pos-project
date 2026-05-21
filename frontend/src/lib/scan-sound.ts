let audioContext: AudioContext | null = null
let unlocked = false

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null

  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }
  return audioContext
}

export async function ensureScanSoundUnlocked() {
  const context = getAudioContext()
  if (!context) return

  if (context.state !== 'running') {
    try {
      await context.resume()
    } catch {
      return
    }
  }

  if (unlocked) return

  try {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'square'
    oscillator.frequency.value = 1040
    gain.gain.value = 0.0001
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.01)
    unlocked = true
  } catch {
    // ignore unlock failures
  }
}

export async function playAcceptedScanSound() {
  let context = getAudioContext()
  if (!context) return

  if (context.state !== 'running') {
    await ensureScanSoundUnlocked()
    context = getAudioContext()
    if (!context || context.state !== 'running') return
  }

  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const start = context.currentTime

  oscillator.frequency.setValueAtTime(1047, start)
  oscillator.frequency.setValueAtTime(1319, start + 0.1)
  gain.gain.setValueAtTime(0.3, start)
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25)

  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + 0.25)
}
