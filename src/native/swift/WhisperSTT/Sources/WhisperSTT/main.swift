import Foundation
import WhisperKit

// On-device speech-to-text helper for Raven.
//
// stdin  : framed PCM, same framing audiocapture writes. Each frame is
//          [1 byte source: 0 = system, 1 = mic][4 bytes little-endian payload
//          length][payload: 16 kHz mono Int16 LE].
// stdout : one JSON object per line.
//          {"type":"ready","model":"..."}
//          {"type":"transcript","source":"mic"|"system","text":"...","final":true|false}
//          {"type":"error","message":"..."}
// stderr : human-readable logs.
//
// Whisper is not a streaming model, so each source is cut into utterances
// with an energy gate. While someone is talking the growing utterance is
// re-decoded about once a second for an interim; a pause (or the length
// cap) decodes it one last time as the final.

let sampleRate = 16000

// MARK: - Arguments

struct Arguments {
    var modelFolder = ""
    var tokenizerFolder: String?
    var language: String?
    var prompt: String?
}

func parseArguments() -> Arguments {
    var args = Arguments()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let flag = it.next() {
        switch flag {
        case "--model-folder": args.modelFolder = it.next() ?? ""
        case "--tokenizer-folder": args.tokenizerFolder = it.next()
        case "--language": args.language = it.next()
        case "--prompt": args.prompt = it.next()
        default: break
        }
    }
    return args
}

// MARK: - Output

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    stdoutLock.unlock()
}

func logLine(_ message: String) {
    FileHandle.standardError.write(Data("[whisperstt] \(message)\n".utf8))
}

// MARK: - Utterance segmentation

enum Source: UInt8 {
    case system = 0
    case mic = 1

    var name: String { self == .mic ? "mic" : "system" }
}

struct Job {
    let source: Source
    let samples: [Float]
    let isFinal: Bool
}

/// Energy-gated utterance cutter for one audio source. Not thread-safe;
/// the stdin reader is the only caller.
final class Segmenter {
    static let frameSize = sampleRate / 50                  // 20 ms
    static let preRollFrames = 15                           // 300 ms kept before speech onset
    static let endSilenceFrames = 35                        // 700 ms pause ends an utterance
    static let minSpeechFrames = 10                         // 200 ms of voiced audio or it is noise
    static let maxUtteranceSamples = sampleRate * 20
    static let interimEverySamples = sampleRate
    static let minInterimSamples = sampleRate

    let source: Source
    private var pending: [Float] = []
    private var preRoll: [[Float]] = []
    private var utterance: [Float] = []
    private var inSpeech = false
    private var silentFrames = 0
    private var voicedFrames = 0
    private var samplesSinceInterim = 0
    private var noiseFloor: Float = 0.002

    init(source: Source) { self.source = source }

    func push(_ samples: [Float], enqueue: (Job) -> Void) {
        pending.append(contentsOf: samples)
        var offset = 0
        while pending.count - offset >= Segmenter.frameSize {
            let frame = Array(pending[offset..<(offset + Segmenter.frameSize)])
            offset += Segmenter.frameSize
            process(frame, enqueue: enqueue)
        }
        if offset > 0 { pending.removeFirst(offset) }
    }

    /// Flush whatever is buffered as a final (end of stream).
    func finish(enqueue: (Job) -> Void) {
        if inSpeech { endUtterance(enqueue: enqueue) }
    }

    private func process(_ frame: [Float], enqueue: (Job) -> Void) {
        var sum: Float = 0
        for s in frame { sum += s * s }
        let rms = (sum / Float(frame.count)).squareRoot()
        let threshold = max(0.006, noiseFloor * 3)
        let voiced = rms > threshold

        if !voiced {
            // Track the room tone only from frames we consider silence.
            noiseFloor = noiseFloor * 0.95 + rms * 0.05
        }

        if !inSpeech {
            if voiced {
                inSpeech = true
                silentFrames = 0
                voicedFrames = 1
                samplesSinceInterim = 0
                utterance = preRoll.flatMap { $0 }
                utterance.append(contentsOf: frame)
                preRoll.removeAll(keepingCapacity: true)
            } else {
                preRoll.append(frame)
                if preRoll.count > Segmenter.preRollFrames { preRoll.removeFirst() }
            }
            return
        }

        utterance.append(contentsOf: frame)
        samplesSinceInterim += frame.count
        if voiced {
            voicedFrames += 1
            silentFrames = 0
        } else {
            silentFrames += 1
        }

        if silentFrames >= Segmenter.endSilenceFrames || utterance.count >= Segmenter.maxUtteranceSamples {
            endUtterance(enqueue: enqueue)
        } else if samplesSinceInterim >= Segmenter.interimEverySamples && utterance.count >= Segmenter.minInterimSamples {
            samplesSinceInterim = 0
            enqueue(Job(source: source, samples: utterance, isFinal: false))
        }
    }

    private func endUtterance(enqueue: (Job) -> Void) {
        if voicedFrames >= Segmenter.minSpeechFrames {
            enqueue(Job(source: source, samples: utterance, isFinal: true))
        } else {
            // Too short to be speech. Still close any interim already shown.
            enqueue(Job(source: source, samples: [], isFinal: true))
        }
        utterance.removeAll(keepingCapacity: true)
        inSpeech = false
        silentFrames = 0
        voicedFrames = 0
        samplesSinceInterim = 0
    }
}

// MARK: - Decode queue

/// One decode at a time across both sources. Finals run in order; an
/// interim is only the latest snapshot for its source and is dropped as
/// soon as that source's final is queued.
final class JobQueue {
    private let condition = NSCondition()
    private var finals: [Job] = []
    private var interims: [Source: Job] = [:]
    private var closed = false

    func enqueue(_ job: Job) {
        condition.lock()
        if job.isFinal {
            interims[job.source] = nil
            finals.append(job)
        } else {
            interims[job.source] = job
        }
        condition.signal()
        condition.unlock()
    }

    func close() {
        condition.lock()
        closed = true
        condition.signal()
        condition.unlock()
    }

    /// Blocks until a job is available; nil once closed and drained.
    func next() -> Job? {
        condition.lock()
        defer { condition.unlock() }
        while true {
            if !finals.isEmpty { return finals.removeFirst() }
            if let (source, job) = interims.first {
                interims[source] = nil
                return job
            }
            if closed { return nil }
            condition.wait()
        }
    }
}

// MARK: - Text cleanup

/// Whisper marks non-speech with bracketed tags ("[BLANK_AUDIO]", "(music)").
/// They are noise in a meeting transcript.
func cleanTranscript(_ raw: String) -> String {
    var text = raw
    for pattern in ["\\[[^\\]]*\\]", "\\([^\\)]*\\)", "<\\|[^|]*\\|>"] {
        text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
    }
    text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Main

let arguments = parseArguments()
guard !arguments.modelFolder.isEmpty else {
    emit(["type": "error", "message": "Missing --model-folder"])
    exit(2)
}

let queue = JobQueue()

// Read stdin on its own thread so decoding never blocks audio intake.
let reader = Thread {
    let input = FileHandle.standardInput
    let segmenters: [Source: Segmenter] = [.mic: Segmenter(source: .mic), .system: Segmenter(source: .system)]
    var buffer = Data()

    while true {
        let chunk = input.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)

        var offset = 0
        while buffer.count - offset >= 5 {
            let base = buffer.startIndex + offset
            let sourceByte = buffer[base]
            let length = Int(buffer[base + 1]) | Int(buffer[base + 2]) << 8 | Int(buffer[base + 3]) << 16 | Int(buffer[base + 4]) << 24
            if buffer.count - offset - 5 < length { break }
            let payload = buffer.subdata(in: (base + 5)..<(base + 5 + length))
            offset += 5 + length

            guard let source = Source(rawValue: sourceByte), let segmenter = segmenters[source] else { continue }
            let sampleCount = payload.count / 2
            var samples = [Float](repeating: 0, count: sampleCount)
            payload.withUnsafeBytes { raw in
                for i in 0..<sampleCount {
                    let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
                    samples[i] = Float(value) / 32768.0
                }
            }
            segmenter.push(samples) { queue.enqueue($0) }
        }
        if offset > 0 { buffer.removeFirst(offset) }
    }

    for segmenter in segmenters.values { segmenter.finish { queue.enqueue($0) } }
    queue.close()
}
reader.stackSize = 1 << 20

let done = DispatchSemaphore(value: 0)

Task.detached {
    do {
        let config = WhisperKitConfig(
            modelFolder: arguments.modelFolder,
            tokenizerFolder: arguments.tokenizerFolder.map { URL(fileURLWithPath: $0) },
            verbose: false,
            logLevel: .error,
            prewarm: false,
            load: true,
            download: false
        )
        let whisper = try await WhisperKit(config)

        var options = DecodingOptions()
        options.task = .transcribe
        options.temperature = 0
        options.withoutTimestamps = true
        options.skipSpecialTokens = true
        options.wordTimestamps = false
        if let language = arguments.language, !language.isEmpty, language != "multi", language != "auto" {
            options.language = String(language.lowercased().prefix(2))
            options.detectLanguage = false
        } else {
            options.detectLanguage = true
        }
        if let prompt = arguments.prompt, !prompt.isEmpty, let tokenizer = whisper.tokenizer {
            options.promptTokens = tokenizer.encode(text: " " + prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
            options.usePrefillPrompt = true
        }

        emit(["type": "ready", "model": URL(fileURLWithPath: arguments.modelFolder).lastPathComponent])
        reader.start()

        while let job = queue.next() {
            var text = ""
            if !job.samples.isEmpty {
                do {
                    let results = try await whisper.transcribe(audioArray: job.samples, decodeOptions: options)
                    text = cleanTranscript(results.map { $0.text }.joined(separator: " "))
                } catch {
                    logLine("decode failed (\(job.source.name)): \(error.localizedDescription)")
                }
            }
            if text.isEmpty && !job.isFinal { continue }
            emit(["type": "transcript", "source": job.source.name, "text": text, "final": job.isFinal])
        }
    } catch {
        emit(["type": "error", "message": "Could not load Whisper model: \(error.localizedDescription)"])
        exit(1)
    }
    done.signal()
}

done.wait()
