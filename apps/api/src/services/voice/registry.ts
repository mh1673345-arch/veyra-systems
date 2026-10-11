import { currentEnvironment } from "../../config/database.js";
import {
  FakeStreamingSpeechToTextProvider,
  FakeStreamingTextToSpeechProvider,
  FakeVoiceProvider
} from "./providers/fakeVoice.js";
import { DeepgramSpeechToTextProvider, deepgramConfig } from "./providers/deepgramStt.js";
import { ElevenLabsTextToSpeechProvider, elevenLabsConfig } from "./providers/elevenLabsTts.js";
import { TwilioVoiceProvider, twilioConfig } from "./providers/twilioVoice.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceProvider,
  VoiceProviderName
} from "./types.js";

/**
 * Which telephony, speech-recognition and speech-synthesis providers this
 * deployment uses.
 *
 *   VEYRA_VOICE_PROVIDER=twilio  requires TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
 *   VEYRA_VOICE_PROVIDER=fake    development/test only — refused in production
 *
 * Speech follows its own credentials rather than the telephony setting: a real
 * key selects the real vendor, and the development stand-ins are used only
 * when no key exists and only outside production. That means a half-configured
 * server degrades honestly instead of quietly speaking with a fake voice.
 */

/** The single development instances; tests and the simulator drive these. */
export const fakeVoiceProvider = new FakeVoiceProvider();
export const fakeSttProvider = new FakeStreamingSpeechToTextProvider();
export const fakeTtsProvider = new FakeStreamingTextToSpeechProvider();

export function configuredVoiceProviderName(env: NodeJS.ProcessEnv = process.env): VoiceProviderName | null {
  const name = env.VEYRA_VOICE_PROVIDER;
  if (name === "twilio" && twilioConfig(env)) return "twilio";
  if (name === "fake" && currentEnvironment(env.NODE_ENV) !== "production") return "fake";
  return null;
}

export function voiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceProvider | null {
  switch (configuredVoiceProviderName(env)) {
    case "twilio":
      return new TwilioVoiceProvider(twilioConfig(env)!);
    case "fake":
      return fakeVoiceProvider;
    default:
      return null;
  }
}

/** For webhooks, which name their provider in the URL. The fake is never served in production. */
export function voiceProviderByName(name: string, env: NodeJS.ProcessEnv = process.env): VoiceProvider | null {
  if (name === "fake") {
    return currentEnvironment(env.NODE_ENV) === "production" ? null : fakeVoiceProvider;
  }
  if (name === "twilio") {
    const config = twilioConfig(env);
    return config ? new TwilioVoiceProvider(config) : null;
  }
  return null;
}

export function speechToTextProvider(env: NodeJS.ProcessEnv = process.env): SpeechToTextProvider | null {
  const deepgram = deepgramConfig(env);
  if (deepgram) return new DeepgramSpeechToTextProvider(deepgram);
  if (currentEnvironment(env.NODE_ENV) === "production") return null;
  return fakeSttProvider;
}

export function textToSpeechProvider(env: NodeJS.ProcessEnv = process.env): TextToSpeechProvider | null {
  const elevenLabs = elevenLabsConfig(env);
  if (elevenLabs) return new ElevenLabsTextToSpeechProvider(elevenLabs);
  if (currentEnvironment(env.NODE_ENV) === "production") return null;
  return fakeTtsProvider;
}

/** What the Console's provider panel reports, without touching a secret. */
export async function speechHealth(env: NodeJS.ProcessEnv = process.env): Promise<{
  stt: { name: string | null; configured: boolean; ok: boolean; detail: string; simulated: boolean };
  tts: { name: string | null; configured: boolean; ok: boolean; detail: string; simulated: boolean };
}> {
  const stt = speechToTextProvider(env);
  const tts = textToSpeechProvider(env);

  const sttHealth =
    stt instanceof DeepgramSpeechToTextProvider
      ? await stt.health()
      : stt
        ? { ok: true, detail: "Development speech recognition — no audio is transcribed." }
        : { ok: false, detail: "No speech recognition provider is configured." };

  const ttsHealth =
    tts instanceof ElevenLabsTextToSpeechProvider
      ? await tts.health()
      : tts
        ? { ok: true, detail: "Development speech synthesis — no audio is produced." }
        : { ok: false, detail: "No speech synthesis provider is configured." };

  return {
    stt: {
      name: stt?.name ?? null,
      configured: stt !== null && stt.name !== "fake",
      ok: sttHealth.ok,
      detail: sttHealth.detail,
      simulated: stt?.name === "fake"
    },
    tts: {
      name: tts?.name ?? null,
      configured: tts !== null && tts.name !== "fake",
      ok: ttsHealth.ok,
      detail: ttsHealth.detail,
      simulated: tts?.name === "fake"
    }
  };
}
