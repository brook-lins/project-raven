/**
 * On-device transcription via the whisperstt Swift helper (WhisperKit).
 *
 * Audio never leaves the machine: AEC-processed PCM is piped to the helper,
 * which cuts it into utterances and prints interim/final transcripts as
 * JSON lines. Transcript state, merging and broadcasting are inherited from
 * TranscriptionService so the overlay and session store see the same shape
 * they get from Deepgram.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync } from 'fs'
import { TranscriptionService } from '../transcriptionService'
import { getSetting } from '../store'
import { createLogger } from '../logger'
import { TRANSCRIPT_FLUSH_TIMEOUT_MS } from '../constants'
import { getWhisperBinaryPath, resolveLocalWhisperModel, whisperTokenizerDir } from './localWhisperModels'
import { MAX_KEYTERMS, parseVocabulary } from './transcriptProviderRouting'

const log = createLogger('LocalWhisper')

type AudioSource = 'mic' | 'system'

// Large models compile their Core ML graphs on first load, which can take
// a while; after that macOS caches the compiled model.
const MODEL_LOAD_TIMEOUT_MS = 180_000

// Same source bytes the audiocapture helper uses on its stdout framing.
const SOURCE_BYTE: Record<AudioSource, number> = { system: 0x00, mic: 0x01 }

// ~10 s of 16 kHz mono Int16. Past this the helper has stalled, and old
// audio is worth less than staying live.
const MAX_STDIN_BACKLOG_BYTES = 320_000

interface HelperMessage {
  type?: string
  source?: string
  text?: string
  final?: boolean
  model?: string
  message?: string
}

export class LocalWhisperTranscriptionService extends TranscriptionService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private stopping = false
  private stdoutBuffer = ''
  private droppedChunks = 0
  private onUnexpectedExit: ((detail: string) => void) | null = null

  /** Called if the helper dies while a recording is running. */
  setExitHandler(handler: (detail: string) => void): void {
    this.onUnexpectedExit = handler
  }

  override async start(): Promise<{ success: boolean; error?: string }> {
    if (this.proc) return { success: true }

    const binaryPath = getWhisperBinaryPath()
    if (!binaryPath) {
      return { success: false, error: 'Local Whisper helper is not built. Run `npm run build:whisper`.' }
    }
    const model = resolveLocalWhisperModel()
    if (!model) {
      return { success: false, error: 'No local Whisper model found. Download a WhisperKit model in MacWhisper first.' }
    }

    const args = ['--model-folder', model.path]
    const tokenizerDir = whisperTokenizerDir()
    if (tokenizerDir) {
      try {
        mkdirSync(tokenizerDir, { recursive: true })
        args.push('--tokenizer-folder', tokenizerDir)
      } catch (err) {
        log.warn('Could not create tokenizer cache dir:', err)
      }
    }
    const language = (getSetting('transcriptionLanguage') as string) || 'en'
    args.push('--language', language)
    // Whisper has no keyterm API; the closest thing is conditioning the
    // decoder on a prompt that already contains the terms. Only the user's
    // own vocabulary goes in: a prompt of just "Raven" makes a small model
    // hear "Raven" in ordinary speech.
    const vocabulary = parseVocabulary(getSetting('vocabulary') as string).slice(0, MAX_KEYTERMS)
    if (vocabulary.length > 0) args.push('--prompt', vocabulary.join(', '))

    log.info(`Starting whisperstt with model ${model.name}`)
    const proc = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.ready = false
    this.stopping = false
    this.stdoutBuffer = ''
    this.droppedChunks = 0

    return new Promise((resolve) => {
      let settled = false
      const settle = (result: { success: boolean; error?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(loadTimeout)
        if (!result.success) this.killHelper()
        resolve(result)
      }

      const loadTimeout = setTimeout(() => {
        log.error(`Model load timed out after ${MODEL_LOAD_TIMEOUT_MS}ms`)
        settle({ success: false, error: 'Local Whisper model took too long to load.' })
      }, MODEL_LOAD_TIMEOUT_MS)

      proc.stdout.on('data', (data: Buffer) => {
        this.stdoutBuffer += data.toString('utf8')
        let newline = this.stdoutBuffer.indexOf('\n')
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim()
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
          newline = this.stdoutBuffer.indexOf('\n')
          if (!line) continue
          let message: HelperMessage
          try {
            message = JSON.parse(line) as HelperMessage
          } catch {
            log.warn('Unparseable helper output:', line.slice(0, 200))
            continue
          }
          if (message.type === 'ready') {
            this.ready = true
            log.info(`Model loaded: ${message.model}`)
            settle({ success: true })
          } else if (message.type === 'error') {
            log.error('Helper error:', message.message)
            settle({ success: false, error: message.message || 'Local Whisper failed to start.' })
          } else if (message.type === 'transcript') {
            this.handleHelperTranscript(message)
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim()
        if (text) log.debug(`whisperstt: ${text}`)
      })

      // EPIPE when the helper exits mid-write; the exit handler reports it.
      proc.stdin.on('error', () => {})

      proc.on('error', (err) => {
        log.error('whisperstt spawn error:', err)
        settle({ success: false, error: 'Local Whisper helper could not be started.' })
      })

      proc.on('exit', (code, signal) => {
        const wasReady = this.ready
        const wasStopping = this.stopping
        log.info(`whisperstt exited (code=${code}, signal=${signal}, expected=${wasStopping})`)
        if (this.proc === proc) {
          this.proc = null
          this.ready = false
        }
        settle({ success: false, error: 'Local Whisper helper exited while loading the model.' })
        if (wasReady && !wasStopping) {
          this.onUnexpectedExit?.(`code=${code}, signal=${signal}`)
        }
      })
    })
  }

  private handleHelperTranscript(message: HelperMessage): void {
    const source: AudioSource | null = message.source === 'mic' ? 'mic' : message.source === 'system' ? 'system' : null
    if (!source) return
    const text = (message.text || '').trim()
    if (!text) {
      // The utterance turned out to be noise; drop the interim it left behind.
      if (message.final) this.clearInterim(source)
      return
    }
    this.handleTranscriptResult(
      { channel: { alternatives: [{ transcript: text }] }, is_final: !!message.final },
      source,
    )
  }

  override sendAudio(buffer: Buffer | ArrayBuffer, source: AudioSource): void {
    const proc = this.proc
    if (!proc || !this.ready || this.stopping) return
    if (proc.stdin.writableLength > MAX_STDIN_BACKLOG_BYTES) {
      this.droppedChunks++
      if (this.droppedChunks === 1 || this.droppedChunks % 200 === 0) {
        log.warn(`whisperstt is not keeping up - dropped ${this.droppedChunks} chunks`)
      }
      return
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    const header = Buffer.alloc(5)
    header[0] = SOURCE_BYTE[source]
    header.writeUInt32LE(buf.byteLength, 1)
    proc.stdin.write(header)
    proc.stdin.write(buf)
  }

  override async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.stopping = true

    // Closing stdin makes the helper decode whatever is still buffered as
    // finals and then exit on its own.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn('Flush timeout reached, killing whisperstt')
        resolve()
      }, TRANSCRIPT_FLUSH_TIMEOUT_MS)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      try {
        proc.stdin.end()
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })

    this.killHelper()
    log.info('Local Whisper stopped')
  }

  private killHelper(): void {
    const proc = this.proc
    this.proc = null
    this.ready = false
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}
