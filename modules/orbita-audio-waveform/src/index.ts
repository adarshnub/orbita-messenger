import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export type NativeWaveformStatus = {
  durationMs: number;
  isPaused: boolean;
  isRecording: boolean;
  level: number;
  waveformSamples: number[];
};

export type NativeWaveformResult = {
  durationMs: number;
  mimeType: string;
  uri: string;
  waveformSamples: number[];
};

type OrbitaAudioWaveformModule = {
  discardRecordingAsync(): Promise<void>;
  getStatusAsync(): Promise<NativeWaveformStatus>;
  isAvailableAsync(): Promise<boolean>;
  pauseRecordingAsync(): Promise<void>;
  resumeRecordingAsync(): Promise<void>;
  startRecordingAsync(): Promise<void>;
  stopRecordingAsync(): Promise<NativeWaveformResult>;
};

function loadNativeModule() {
  if (Platform.OS === "web") return null;
  try {
    return requireNativeModule<OrbitaAudioWaveformModule>("OrbitaAudioWaveform");
  } catch {
    return null;
  }
}

const NativeModule = loadNativeModule();

export const orbitaAudioWaveform = {
  discardRecordingAsync() {
    return NativeModule?.discardRecordingAsync() ?? Promise.resolve();
  },
  getStatusAsync() {
    return NativeModule?.getStatusAsync() ?? Promise.resolve({
      durationMs: 0,
      isPaused: false,
      isRecording: false,
      level: 0,
      waveformSamples: [],
    });
  },
  isAvailableAsync() {
    return NativeModule?.isAvailableAsync() ?? Promise.resolve(false);
  },
  pauseRecordingAsync() {
    return NativeModule?.pauseRecordingAsync() ?? Promise.resolve();
  },
  resumeRecordingAsync() {
    return NativeModule?.resumeRecordingAsync() ?? Promise.resolve();
  },
  startRecordingAsync() {
    if (!NativeModule) return Promise.reject(new Error("Native waveform recorder is not available on web."));
    return NativeModule.startRecordingAsync();
  },
  stopRecordingAsync() {
    if (!NativeModule) return Promise.reject(new Error("Native waveform recorder is not available on web."));
    return NativeModule.stopRecordingAsync();
  },
};
