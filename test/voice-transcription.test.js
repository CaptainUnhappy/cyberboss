const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VoiceTranscriptionService,
  enrichMessageWithVoiceTranscripts,
} = require("../src/services/voice-transcription");

function createVoiceFixture(dir, name = "voice.wav") {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(`fixture:${name}`));
  return filePath;
}

test("voice transcripts are cached by audio content and model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-cache-"));
  const audioPath = createVoiceFixture(dir);
  let calls = 0;
  const service = new VoiceTranscriptionService({
    config: {
      voiceTranscriptionMode: "auto",
      voiceTranscriptionModel: "fixture-model",
      voiceTranscriptionLanguage: "zh",
      voiceTranscriptCacheDir: path.join(dir, "cache"),
    },
    transcribeImpl: async () => {
      calls += 1;
      return { text: "帮我总结一下这段话", language: "zh", duration: 3.2 };
    },
  });
  const attachment = { kind: "voice", absolutePath: audioPath };
  const first = await service.transcribeAttachment(attachment);
  const second = await service.transcribeAttachment(attachment);
  assert.equal(first.text, "帮我总结一下这段话");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("direct voice becomes current text while quoted voice stays quoted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-route-"));
  const result = await enrichMessageWithVoiceTranscripts({
    message: {
      kind: "voice",
      text: "",
      quotedContexts: [{ kind: "voice", title: "语音", text: "", attachmentRefs: ["quoted:1"] }],
    },
    attachments: [{
      kind: "voice", origin: "direct", absolutePath: createVoiceFixture(dir, "direct.wav"), attachmentRef: "direct:1",
    }, {
      kind: "voice", origin: "quoted", absolutePath: createVoiceFixture(dir, "quoted.wav"), attachmentRef: "quoted:1",
    }],
    transcriptionService: {
      async transcribeAttachment(attachment) {
        return { text: attachment.origin === "quoted" ? "这是被引用的旧语音" : "请回答这个问题", language: "zh" };
      },
    },
  });
  assert.equal(result.message.text, "请回答这个问题");
  assert.equal(result.message.voiceTranscript, "请回答这个问题");
  assert.equal(result.message.quotedContexts[0].text, "这是被引用的旧语音");
  assert.equal(result.failures.length, 0);
});

test("voice transcription errors retain origin and reference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-voice-error-"));
  const result = await enrichMessageWithVoiceTranscripts({
    message: { kind: "voice", text: "", quotedContexts: [] },
    attachments: [{
      kind: "voice", origin: "quoted", absolutePath: createVoiceFixture(dir),
      attachmentRef: "quoted:2", sourceFileName: "voice.wav",
    }],
    transcriptionService: { async transcribeAttachment() { throw new Error("fixture ASR failure"); } },
  });
  assert.deepEqual(result.failures, [{
    kind: "voice", origin: "quoted", attachmentRef: "quoted:2",
    sourceFileName: "voice.wav", reason: "fixture ASR failure",
  }]);
});
